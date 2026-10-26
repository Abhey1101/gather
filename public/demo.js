const PASSWORD = 'Password123!';
const TEXT = {
  like: 'liked your post', comment: 'commented on your post', reply: 'replied to your comment',
  follow: 'started following you', follow_request: 'requested to follow you', mention: 'mentioned you',
};

class Client {
  constructor(root, username) {
    this.root = root;
    this.username = username;
    this.email = `${username}@example.com`;
    this.token = null;
    root.innerHTML = `
      <h2>@${username} <span class="badge" data-unread>0</span></h2>
      <small data-status>logged out</small>
      <div class="row"><button data-login>Log in (auto-register)</button></div>
      <div class="row"><input data-follow placeholder="username to follow" /><button data-follow-btn>Follow</button></div>
      <div class="row"><input data-caption placeholder="Write a post, try #hashtags" /><button data-post>Post</button></div>
      <h3>Live notifications</h3><ul data-notifs></ul>
      <h3>Feed <button class="ghost" data-refresh>refresh</button></h3><div data-feed></div>`;
    this.$ = (s) => root.querySelector(s);
    this.$('[data-login]').onclick = () => this.login();
    this.$('[data-follow-btn]').onclick = () => this.follow();
    this.$('[data-post]').onclick = () => this.post();
    this.$('[data-refresh]').onclick = () => this.loadFeed();
  }

  async api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.token && { authorization: `Bearer ${this.token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  async login() {
    let r;
    try {
      r = await this.api('/api/auth/login', 'POST', { email: this.email, password: PASSWORD });
    } catch {
      r = await this.api('/api/auth/register', 'POST', { name: this.username, username: this.username, email: this.email, password: PASSWORD });
    }
    this.token = r.accessToken;
    this.userId = r.user.id;
    this.connect();
    await this.refreshUnread();
    await this.loadFeed();
  }

  connect() {
    this.socket?.disconnect();
    this.socket = io({ auth: { token: this.token } });
    this.socket.on('ready', (i) => (this.$('[data-status]').textContent = `connected via instance ${i.instance}`));
    this.socket.on('connect_error', (e) => (this.$('[data-status]').textContent = `socket error: ${e.message}`));
    this.socket.on('notification:new', (n) => this.onNotification(n));
    this.socket.on('post:liked', ({ postId, likeCount }) => {
      const el = this.$(`[data-likes="${postId}"]`);
      if (el) el.textContent = likeCount;
    });
  }

  async refreshUnread() {
    const { unreadCount } = await this.api('/api/notifications/unread-count');
    this.$('[data-unread]').textContent = unreadCount;
  }

  onNotification(n) {
    this.$('[data-unread]').textContent = n.unreadCount;
    const names = n.actors.map((a) => '@' + a.username);
    const extra = n.actorCount - names.length;
    const who = names.join(', ') + (extra > 0 ? ` and ${extra} others` : '');
    const ul = this.$('[data-notifs]');
    ul.querySelector(`[data-nid="${n.id}"]`)?.remove(); // aggregated: same doc updates in place
    const li = document.createElement('li');
    li.dataset.nid = n.id;
    li.className = 'flash';
    li.textContent = `${who} ${TEXT[n.type] || n.type}` + (n.preview ? `: “${n.preview}”` : '');
    ul.prepend(li);
  }

  async follow() {
    const name = this.$('[data-follow]').value.trim().toLowerCase();
    if (!name) return;
    try {
      const { user } = await this.api(`/api/users/${encodeURIComponent(name)}`);
      const r = await this.api(`/api/users/${user._id}/follow`, 'POST');
      this.$('[data-status]').textContent = `follow status: ${r.status}`;
      await this.loadFeed();
    } catch (e) {
      this.$('[data-status]').textContent = e.message;
    }
  }

  async post() {
    const input = this.$('[data-caption]');
    if (!input.value.trim()) return;
    await this.api('/api/posts', 'POST', { caption: input.value });
    input.value = '';
    setTimeout(() => this.loadFeed(), 400); // fan-out is async (BullMQ)
  }

  async loadFeed() {
    const { items } = await this.api('/api/feed?limit=10');
    const box = this.$('[data-feed]');
    box.replaceChildren();
    for (const p of items) {
      const div = document.createElement('div');
      div.className = 'post';
      const who = document.createElement('b');
      who.textContent = '@' + p.author.username;
      const text = document.createElement('div');
      text.textContent = p.caption;
      const like = document.createElement('button');
      like.className = 'ghost';
      const count = document.createElement('span');
      count.dataset.likes = p._id;
      count.textContent = p.likeCount;
      let liked = p.likedByMe;
      const paint = () => (like.firstChild.nodeValue = liked ? 'Unlike ' : 'Like ');
      like.append(document.createTextNode(''), count);
      paint();
      like.onclick = async () => {
        const r = await this.api(`/api/posts/${p._id}/like`, liked ? 'DELETE' : 'POST');
        liked = r.liked;
        count.textContent = r.likeCount;
        paint();
      };
      this.socket?.emit('post:watch', p._id);
      div.append(who, text, like);
      box.append(div);
    }
    if (!items.length) box.textContent = 'Feed is empty. Follow someone who has posted.';
  }
}

new Client(document.getElementById('alice'), 'alice_demo');
new Client(document.getElementById('bob'), 'bob_demo');
