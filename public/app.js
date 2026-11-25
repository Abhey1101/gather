const API = '/api';
const state = { accessToken: localStorage.getItem('gather_access') || '', refreshToken: localStorage.getItem('gather_refresh') || '', user: null, authMode: 'login', view: 'feed', cursor: null, loading: false, selectedImages: [], existingMedia: [], previewUrls: [], commentPostId: null, editingPostId: null, profilePosts: [], analyticsRequest: 0, connections: null };
const $ = (s) => document.querySelector(s);
const escapeHtml = (v='') => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const avatar = (user={}) => user.avatarUrl ? `<div class="avatar"><img src="${escapeHtml(user.avatarUrl)}" alt=""></div>` : `<div class="avatar">${escapeHtml((user.name || user.username || 'G').slice(0,1).toUpperCase())}</div>`;
function toast(message, error=false){const el=$('#toast');el.textContent=message;el.classList.toggle('error',error);el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3200)}
async function request(path, options={}) {
  const headers = new Headers(options.headers || {});
  if (state.accessToken) headers.set('Authorization', `Bearer ${state.accessToken}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type','application/json');
  let response = await fetch(`${API}${path}`, {...options, headers});
  if(response.status===401 && state.refreshToken && !path.startsWith('/auth/')) {
    const refreshed = await fetch(`${API}/auth/refresh`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken:state.refreshToken})});
    if(refreshed.ok){const data=await refreshed.json();saveTokens(data);headers.set('Authorization',`Bearer ${state.accessToken}`);response=await fetch(`${API}${path}`,{...options,headers});}
  }
  const text = response.status===204 ? '' : await response.text(); let data={};try{data=text?JSON.parse(text):{}}catch{data={message:text}}
  if(!response.ok) throw new Error(data.message || data.error || `Request failed (${response.status})`);
  return data;
}
function saveTokens(data){if(data.accessToken){state.accessToken=data.accessToken;localStorage.setItem('gather_access',data.accessToken)}if(data.refreshToken){state.refreshToken=data.refreshToken;localStorage.setItem('gather_refresh',data.refreshToken)}}
function updatePasswordStrength(){
  const password=$('#authForm').elements.password.value;
  const score=[password.length>=8,/[a-z]/.test(password)&&/[A-Z]/.test(password),/[0-9]/.test(password),/[^a-zA-Z0-9]/.test(password)].filter(Boolean).length;
  const meter=$('#passwordStrength');
  meter.dataset.strength=score;
  $('#strengthText').textContent=['Add a few more details','Could be stronger','Getting there','Strong password','Excellent password'][score];
}
function updatePasswordMatch(){
  const password=$('#authForm').elements.password.value;
  const confirmation=$('#authForm').elements.confirmPassword.value;
  const hint=$('#passwordMatch');
  hint.textContent=!confirmation?'Re-enter your password to confirm.':password===confirmation?'Passwords match.':'Passwords do not match yet.';
  hint.dataset.match=confirmation&&password===confirmation?'true':'false';
}
function setAuthMode(mode){
  state.authMode=mode;
  const registering=mode==='register';
  document.querySelectorAll('[data-auth]').forEach(button=>{
    const active=button.dataset.auth===mode;
    button.classList.toggle('active',active);
    button.setAttribute('aria-selected',String(active));
    button.tabIndex=active?0:-1;
  });
  $('#authForm').dataset.mode=mode;
  $('#authTitle').textContent=registering?'Join the community':'Welcome back';
  $('#authSubtitle').textContent=registering?'Create your account and find your people.':'Pick up where your community left off.';
  $('#authSubmit .submit-label').textContent=registering?'Create account':'Log in';
  $('#nameLabel').classList.toggle('hidden',!registering);
  $('#usernameLabel').classList.toggle('hidden',!registering);
  $('#confirmPasswordLabel').classList.toggle('hidden',!registering);
  $('#passwordStrength').classList.toggle('hidden',!registering);
  $('#authForm').elements.password.autocomplete=registering?'new-password':'current-password';
  for(const name of ['name','username','confirmPassword']) $('#authForm').elements[name].required=registering;
  document.querySelectorAll('[data-password-toggle]').forEach(button=>{
    const input=button.closest('.password-input').querySelector('input');
    input.type='password';
    button.setAttribute('aria-label','Show password');
    button.setAttribute('aria-pressed','false');
    button.querySelector('span').textContent='Show';
  });
  $('#authMessage').textContent='';
  $('#authMessage').removeAttribute('data-state');
  updatePasswordStrength();
  updatePasswordMatch();
}
function showSignedIn(){ $('#authPanel').classList.add('hidden');$('#appView').classList.remove('hidden');$('#logoutBtn').classList.remove('hidden');$('#sideName').textContent=state.user?.name||'Your profile';$('#sideHandle').textContent='@'+(state.user?.username||'member');$('#sideAvatar').innerHTML=state.user?.avatarUrl?`<img src="${escapeHtml(state.user.avatarUrl)}">`:escapeHtml((state.user?.name||'G').slice(0,1).toUpperCase());$('#composerAvatar').innerHTML=$('#sideAvatar').innerHTML;$('#commentAvatar').innerHTML=$('#sideAvatar').innerHTML;$('#topCreateBtn').classList.remove('hidden');loadFeed();loadTrending();loadSuggestedUsers();loadUnread();const sharedProfile=new URLSearchParams(location.search).get('profile');if(sharedProfile)showProfile(sharedProfile);}
function showSignedOut(){state.user=null;state.accessToken='';state.refreshToken='';localStorage.removeItem('gather_access');localStorage.removeItem('gather_refresh');$('#authPanel').classList.remove('hidden');$('#appView').classList.add('hidden');$('#simpleView').classList.add('hidden');$('#logoutBtn').classList.add('hidden');$('#sideName').textContent='Guest user';$('#sideHandle').textContent='Sign in to continue';$('#sideAvatar').textContent='G';$('#composerAvatar').textContent='G';}
$('#authForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const form=e.currentTarget;
  if(!form.reportValidity())return;
  const message=$('#authMessage');
  message.textContent='';
  message.removeAttribute('data-state');
  if(state.authMode==='register'&&form.elements.password.value!==form.elements.confirmPassword.value){
    updatePasswordMatch();
    message.textContent='Those passwords do not match yet.';
    message.dataset.state='error';
    form.elements.confirmPassword.focus();
    return;
  }
  const registering=state.authMode==='register';
  const payload={email:form.elements.email.value,password:form.elements.password.value};
  if(registering){payload.name=form.elements.name.value;payload.username=form.elements.username.value}
  const submit=$('#authSubmit');
  submit.disabled=true;
  submit.setAttribute('aria-busy','true');
  submit.classList.add('is-loading');
  document.querySelectorAll('[data-auth]').forEach(button=>button.disabled=true);
  try{
    const endpoint=registering?'/auth/register':'/auth/login';
    const data=await request(endpoint,{method:'POST',body:JSON.stringify(payload)});
    saveTokens(data);
    state.user=data.user;
    showSignedIn();
    toast(registering?'Your account is ready!':'Welcome back!');
  }catch(err){
    message.textContent=err.message;
    message.dataset.state='error';
  }finally{
    submit.disabled=false;
    submit.removeAttribute('aria-busy');
    submit.classList.remove('is-loading');
    document.querySelectorAll('[data-auth]').forEach(button=>button.disabled=false);
  }
});
document.querySelectorAll('[data-auth]').forEach((button,index,buttons)=>{
  button.addEventListener('click',()=>setAuthMode(button.dataset.auth));
  button.addEventListener('keydown',event=>{
    const direction=event.key==='ArrowRight'||event.key==='ArrowDown'?1:event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:0;
    if(!direction)return;
    event.preventDefault();
    const next=buttons[(index+direction+buttons.length)%buttons.length];
    next.focus();
    next.click();
  });
});
document.querySelectorAll('[data-password-toggle]').forEach(button=>button.addEventListener('click',()=>{
  const input=button.closest('.password-input').querySelector('input');
  const showing=input.type==='password';
  input.type=showing?'text':'password';
  button.setAttribute('aria-label',showing?'Hide password':'Show password');
  button.setAttribute('aria-pressed',String(showing));
  button.querySelector('span').textContent=showing?'Hide':'Show';
}));
$('#authForm').elements.password.addEventListener('input',()=>{updatePasswordStrength();updatePasswordMatch()});
$('#authForm').elements.confirmPassword.addEventListener('input',updatePasswordMatch);
$('#logoutBtn').addEventListener('click',async()=>{try{if(state.refreshToken)await request('/auth/logout',{method:'POST',body:JSON.stringify({refreshToken:state.refreshToken})})}catch{}showSignedOut();toast('You have logged out.')});
function applyTheme(theme){
  document.documentElement.dataset.theme=theme;
  localStorage.setItem('gather_theme',theme);
  $('#themeToggle')?.setAttribute('aria-pressed',String(theme==='dark'));
}
applyTheme(localStorage.getItem('gather_theme')||'light');
$('#themeToggle').addEventListener('click',()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
const postForm=$('#postForm');
async function compressImage(file, maxDimension=1600, quality=.82){
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)) return file;
  const bitmap=await createImageBitmap(file);
  const scale=Math.min(1,maxDimension/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));
  canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const context=canvas.getContext('2d');
  context.drawImage(bitmap,0,0,canvas.width,canvas.height);
  bitmap.close();
  const blob=await new Promise((resolve)=>canvas.toBlob(resolve,file.type,quality));
  if(!blob)return file;
  return new File([blob],file.name,{type:file.type,lastModified:file.lastModified});
}
function renderImagePreviews(){
  state.previewUrls.forEach((url)=>URL.revokeObjectURL(url));
  state.previewUrls=state.selectedImages.map((file)=>URL.createObjectURL(file));
  const preview=$('#postImagePreviews');
  preview.classList.toggle('hidden',!state.selectedImages.length&&!state.existingMedia.length);
  preview.innerHTML=state.existingMedia.map((item,index)=>`<div class="image-preview"><img src="${escapeHtml(item.url)}" alt="Existing photo ${index+1}"><button type="button" data-remove-existing="${index}" aria-label="Remove existing photo">×</button></div>`).join('')+
    state.selectedImages.map((file,index)=>`<div class="image-preview"><img src="${state.previewUrls[index]}" alt="Selected photo ${index+1}"><button type="button" data-remove-image="${index}" aria-label="Remove ${escapeHtml(file.name)}">×</button></div>`).join('');
  const total=state.existingMedia.length+state.selectedImages.length;
  $('#photoCount').textContent=total?`${total}/5 selected`:'Up to 5';
}
postForm.elements.caption.addEventListener('input',(event)=>$('#charCount').textContent=event.target.value.length);
postForm.elements.images.addEventListener('change',async(event)=>{
  const files=[...event.target.files];
  const invalid=files.find((file)=>!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)||file.size>8*1024*1024);
  const message=$('#postMessage');
  message.textContent='';
  message.removeAttribute('data-state');
  if(files.length>5||invalid){
    message.textContent=invalid?`${invalid.name} is not a supported image or is larger than 8 MB.`:'Choose no more than 5 photos per post.';
    message.dataset.state='error';
    event.target.value='';
    return;
  }
  try{
    const compressed=await Promise.all(files.map((file)=>compressImage(file)));
    state.selectedImages=[...state.selectedImages,...compressed].slice(0,5-state.existingMedia.length);
    renderImagePreviews();
  }catch{
    message.textContent='One of the images could not be processed.';
    message.dataset.state='error';
  }
});
$('#postImagePreviews').addEventListener('click',(event)=>{
  const remove=event.target.closest('[data-remove-image]');
  const removeExisting=event.target.closest('[data-remove-existing]');
  if(remove){state.selectedImages.splice(Number(remove.dataset.removeImage),1)}
  if(removeExisting){state.existingMedia.splice(Number(removeExisting.dataset.removeExisting),1)}
  if(remove||removeExisting){postForm.elements.images.value='';renderImagePreviews()}
});
postForm.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const caption=postForm.elements.caption.value.trim();
  if(!caption&&!state.selectedImages.length){
    $('#postMessage').textContent='Add a caption or choose a photo before sharing.';
    $('#postMessage').dataset.state='error';
    return;
  }
  const message=$('#postMessage');
  message.textContent='';
  message.removeAttribute('data-state');
  const button=postForm.querySelector('button[type=submit]');
  button.disabled=true;
  button.setAttribute('aria-busy','true');
  try{
    const body=new FormData();
    body.set('caption',caption);
    body.set('location',postForm.elements.location.value.trim());
    state.selectedImages.forEach((file)=>body.append('images',file));
    await request('/posts',{method:'POST',body});
    postForm.reset();
    state.selectedImages=[];
    renderImagePreviews();
    $('#charCount').textContent='0';
    toast('Your post is live!');
    state.cursor=null;
    await loadFeed();
  }catch(error){
    message.textContent=error.message;
    message.dataset.state='error';
  }finally{
    button.disabled=false;
    button.removeAttribute('aria-busy');
  }
});
function dateLabel(value){if(!value)return 'just now';const d=new Date(value);if(Number.isNaN(d.getTime()))return 'recently';return new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(d)}
function postCard(post){
  const author=post.author||post.authorUser||post.user||{};
  const id=post._id||post.id||post.postId;
  const caption=post.caption||'';
  const media=Array.isArray(post.media)?post.media.filter((item)=>item.url):[];
  const images=media.map((item,index)=>`<img class="post-media${index?' hidden':''}" src="${escapeHtml(item.url)}" alt="Photo ${index+1} of ${media.length} by ${escapeHtml(author.username||'community member')}" loading="lazy">`).join('');
  const carousel=media.length?`<div class="post-carousel" data-carousel-index="0">${images}${media.length>1?`<button class="carousel-arrow carousel-prev" type="button" data-carousel-step="-1" aria-label="Previous photo">‹</button><button class="carousel-arrow carousel-next" type="button" data-carousel-step="1" aria-label="Next photo">›</button><span class="carousel-count">1 / ${media.length}</span><div class="carousel-dots">${media.map((_,index)=>`<button type="button" class="carousel-dot${index?'':' active'}" data-carousel-index="${index}" aria-label="Show photo ${index+1}"></button>`).join('')}</div>`:''}</div>`:'';
  const liked=post.likedByMe||post.likedByViewer||post.isLiked||post.liked;
  const saved=post.savedByMe||post.savedByViewer||post.isSaved;
  const profileName=author.name||author.username||'Community member';
  const username=author.username||'member';
  const captionMarkup=caption?`<p class="post-caption"><button class="caption-author" type="button" data-profile="${escapeHtml(username)}">${escapeHtml(username)}</button> ${escapeHtml(caption).replace(/(^|\s)(#[a-z0-9_]+)/gi,'$1<span class="hashtag">$2</span>').replace(/\n/g,'<br>')}</p>`:'';
  return `<article class="post-card card" data-post-id="${escapeHtml(id||'')}"><header class="post-header"><button class="post-author-profile" type="button" data-profile="${escapeHtml(username)}">${avatar(author)}<span class="author-meta"><strong>${escapeHtml(profileName)}</strong><small>@${escapeHtml(username)} · ${escapeHtml(dateLabel(post.createdAt))}</small></span></button>${author.username===state.user?.username?`<div class="post-menu-wrap"><button class="post-menu" type="button" data-post-menu="${escapeHtml(id||'')}" aria-label="Post options">···</button><div class="post-menu-actions hidden" data-post-menu-actions="${escapeHtml(id||'')}"><button type="button" data-edit-post="${escapeHtml(id||'')}">Edit post</button><button type="button" data-delete="${escapeHtml(id||'')}">Delete post</button></div></div>`:''}</header>${carousel}<div class="post-body">${captionMarkup}<div class="post-stats"><span class="like-count" data-like-count>♥ ${Number(post.likeCount||0)} ${Number(post.likeCount||0)===1?'like':'likes'}</span><button type="button" class="comment-count" data-comment="${escapeHtml(id||'')}">View all ${Number(post.commentCount||0)} comments</button>${post.location?`<span>⌖ ${escapeHtml(post.location)}</span>`:''}</div><div class="post-actions"><button type="button" class="post-action like-action${liked?' liked':''}" data-like="${escapeHtml(id||'')}" data-liked="${liked?'1':'0'}" aria-pressed="${liked?'true':'false'}"><span aria-hidden="true">${liked?'♥':'♡'}</span><span>${liked?'Liked':'Like'}</span></button><button type="button" class="post-action" data-comment="${escapeHtml(id||'')}"><span aria-hidden="true">▤</span><span>Comment</span></button><button type="button" class="post-action save-action${saved?' liked':''}" data-save="${escapeHtml(id||'')}" data-saved="${saved?'1':'0'}" aria-pressed="${saved?'true':'false'}"><span aria-hidden="true">♧</span><span>${saved?'Saved':'Save'}</span></button></div></div></article>`;
}
async function loadFeed(append=false){if(state.loading)return;state.loading=true;const list=$('#feedList');if(!append){state.cursor=null;list.innerHTML='<div class="empty-state"><div class="loading-spinner"></div><p>Loading your feed…</p></div>'}try{const qs=new URLSearchParams({limit:'10'});if(append&&state.cursor)qs.set('cursor',state.cursor);const data=await request(`/feed?${qs}`);const items=data.items||data.posts||data.feed||[];state.cursor=data.nextCursor||null;const html=items.map(postCard).join('');if(!append)list.innerHTML=html||'<div class="empty-state"><div class="empty-icon">✳</div><strong>Your feed is ready for a first post.</strong><p>Follow people or share something to get the conversation started.</p></div>';else list.insertAdjacentHTML('beforeend',html);$('#loadMoreBtn').classList.toggle('hidden',!state.cursor);if(!items.length&&!append)$('#loadMoreBtn').classList.add('hidden')}catch(err){list.innerHTML=`<div class="empty-state"><strong>Couldn't load your feed</strong><p>${escapeHtml(err.message)}</p><button class="button button-light" id="retryFeed">Try again</button></div>`;$('#retryFeed')?.addEventListener('click',()=>loadFeed())}finally{state.loading=false}}
$('#loadMoreBtn').addEventListener('click',()=>loadFeed(true));$('#refreshBtn').addEventListener('click',()=>state.view==='feed'?loadFeed():state.view==='profile'?showProfile(state.currentProfile):navigate(state.view));$('#topCreateBtn').addEventListener('click',()=>{$('#composer').scrollIntoView({behavior:'smooth',block:'center'});$('#postForm').elements.caption.focus()});
function updatePostCounts(postId,{likeCount,commentCount}={}){
  document.querySelectorAll(`[data-post-id="${CSS.escape(postId)}"]`).forEach((card)=>{
    if(likeCount!==undefined){
      const label=card.querySelector('[data-like-count]');
      if(label)label.textContent=`♥ ${likeCount} ${likeCount===1?'like':'likes'}`;
    }
    if(commentCount!==undefined){
      const label=card.querySelector('.comment-count');
      if(label)label.textContent=`View all ${commentCount} comments`;
    }
  });
}
function renderComment(comment){
  const author=comment.author||{};
  const username=author.username||'member';
  return `<article class="comment-row">${avatar(author)}<p><button type="button" class="caption-author" data-profile="${escapeHtml(username)}">${escapeHtml(username)}</button> ${escapeHtml(comment.body||'')}</p><time>${escapeHtml(dateLabel(comment.createdAt))}</time></article>`;
}
async function openComments(postId){
  state.commentPostId=postId;
  const dialog=$('#commentsDialog');
  const card=document.querySelector(`[data-post-id="${CSS.escape(postId)}"]`);
  const author=card?.querySelector('.post-author-profile')?.dataset.profile||'community member';
  const caption=card?.querySelector('.post-caption')?.innerText.replace(/^\S+\s*/,'')||'';
  $('#commentsPostSummary').innerHTML=caption?`<strong>${escapeHtml(author)}</strong> ${escapeHtml(caption)}`:`<strong>${escapeHtml(author)}</strong>'s post`;
  $('#commentList').innerHTML='<p class="muted tiny">Loading comments…</p>';
  $('#commentForm').elements.body.value='';
  if(!dialog.open)dialog.showModal();
  try{
    const data=await request(`/posts/${postId}/comments?limit=30`);
    const items=data.items||[];
    $('#commentList').innerHTML=items.length?items.map(renderComment).join(''):'<p class="muted tiny comments-empty">No comments yet. Start the conversation.</p>';
  }catch(error){
    $('#commentList').innerHTML=`<p class="form-message" data-state="error">${escapeHtml(error.message)}</p>`;
  }
}
$('#commentsDialog').addEventListener('click',(event)=>{
  if(event.target===event.currentTarget||event.target.closest('[data-close-comments]'))event.currentTarget.close();
});
$('#commentForm').addEventListener('submit',async(event)=>{
  event.preventDefault();
  const form=event.currentTarget;
  const body=form.elements.body.value.trim();
  if(!body||!state.commentPostId)return;
  const button=form.querySelector('button[type=submit]');
  button.disabled=true;
  try{
    const data=await request(`/posts/${state.commentPostId}/comments`,{method:'POST',body:JSON.stringify({body})});
    $('#commentList .comments-empty')?.remove();
    $('#commentList').insertAdjacentHTML('beforeend',renderComment({...data.comment,author:state.user}));
    updatePostCounts(state.commentPostId,{commentCount:data.commentCount});
    form.reset();
  }catch(error){toast(error.message,true)}finally{button.disabled=false}
});
document.addEventListener('click',async(event)=>{
  const target=event.target;
  const profile=target.closest('[data-profile]');
  const profileSelf=target.closest('[data-profile-self]');
  const carouselStep=target.closest('[data-carousel-step]');
  const carouselDot=target.closest('.carousel-dot');
  const like=target.closest('[data-like]');
  const save=target.closest('[data-save]');
  const comment=target.closest('[data-comment]');
  const del=target.closest('[data-delete]');
  const follow=target.closest('[data-follow-user]');
  const followRequest=target.closest('[data-follow-request]');
  const profilePost=target.closest('[data-profile-post]');
  const postMenu=target.closest('[data-post-menu]');
  const editPost=target.closest('[data-edit-post]');
  const profileList=target.closest('[data-profile-list]');
  try{
    if(target.closest('[data-retry-analytics]')){
      await loadAnalytics(target.closest('[data-retry-analytics]').dataset.retryAnalytics);
    }
    else if(target.closest('[data-retry-connections]')){
      await loadConnectionPage();
    }
    else if(profileList){
      await showConnections(profileList.dataset.username,profileList.dataset.profileList);
    }
    else if(target.closest('[data-close-connections]')){
      $('#profileConnectionsDialog').close();
    }
    else if(target.closest('#profileConnectionsMore')){
      await loadConnectionPage(true);
    }
    else if(postMenu){
      const menu=document.querySelector(`[data-post-menu-actions="${CSS.escape(postMenu.dataset.postMenu)}"]`);
      document.querySelectorAll('[data-post-menu-actions]').forEach((item)=>{if(item!==menu)item.classList.add('hidden')});
      menu?.classList.toggle('hidden');
    }
    else if(editPost){
      const data=await request(`/posts/${editPost.dataset.editPost}`);
      const post=data.post;
      state.editingPostId=editPost.dataset.editPost;
      const form=$('#postEditForm');
      form.elements.caption.value=post.caption||'';
      form.elements.location.value=post.location||'';
      state.editingMedia=(post.media||[]).filter((item)=>item.url).map((item)=>item.url);
      $('#postEditMedia').innerHTML=state.editingMedia.length?state.editingMedia.map((url,index)=>`<div class="image-preview"><img src="${escapeHtml(url)}" alt="Post photo ${index+1}"><button type="button" data-remove-edit-media="${index}" aria-label="Remove photo">×</button></div>`):'<p class="muted tiny">No photos in this post.</p>';
      $('#postEditCharCount').textContent=String(form.elements.caption.value.length);
      $('#postEditMessage').textContent='';
      $('#postEditDialog').showModal();
    }
    else if(target.closest('[data-close-post-edit]'))$('#postEditDialog').close();
    else if(profile){event.preventDefault();if($('#profileConnectionsDialog').open)$('#profileConnectionsDialog').close();await showProfile(profile.dataset.profile)}
    else if(profileSelf){await showProfile(state.user?.username)}
    else if(target.closest('[data-edit-profile]')){
      const form=$('#profileEditForm');
      const {user}=await request('/users/me');
      state.user={...state.user,...user};
      form.elements.name.value=state.user?.name||'';
      form.elements.username.value=state.user?.username||'';
      form.elements.email.value=state.user?.email||'';
      form.elements.avatarUrl.value=state.user?.avatarUrl||'';
      form.elements.coverUrl.value=state.user?.coverUrl||'';
      form.elements.bio.value=state.user?.bio||'';
      form.elements.location.value=state.user?.location||'';
      form.elements.website.value=state.user?.website||'';
      form.elements.birthday.value=state.user?.birthday||'';
      form.elements.pronouns.value=state.user?.pronouns||'';
      form.elements.gender.value=state.user?.gender||'';
      $('#profileBioCount').textContent=String(form.elements.bio.value.length);
      form.elements.isPrivate.checked=Boolean(state.user?.isPrivate);
      $('#profileEditMessage').textContent='';
      $('#profileEditDialog').showModal();
    }
    else if(target.closest('[data-share-profile]')){
      const profileUrl=new URL(location.href);
      profileUrl.search='';profileUrl.hash='';
      profileUrl.searchParams.set('profile',state.currentProfile);
      if(navigator.share)await navigator.share({title:`${state.currentProfile} on Gather`,url:profileUrl.href});
      else if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(profileUrl.href);toast('Profile link copied');}
      else {window.prompt('Copy this profile link',profileUrl.href);}
    }
    else if(profilePost){
      const post=state.profilePosts.find((item)=>String(item._id||item.id||item.postId)===profilePost.dataset.profilePost);
      if(post){$('#profilePostContent').innerHTML=postCard(post);$('#profilePostDialog').showModal();}
    }
    else if(target.closest('[data-close-profile-dialog]'))target.closest('dialog')?.close();
    else if(target.closest('[data-profile-create]')){navigate('feed');setTimeout(()=>{$('#composer').scrollIntoView({behavior:'smooth',block:'center'});$('#postForm').elements.caption.focus()},0)}
    else if(target.closest('[data-go-feed]'))navigate('feed');
    else if(carouselStep||carouselDot){
      const carousel=target.closest('.post-carousel');
      const images=[...carousel.querySelectorAll('.post-media')];
      const dots=[...carousel.querySelectorAll('.carousel-dot')];
      const direction=carouselStep?Number(carouselStep.dataset.carouselStep):0;
      const requested=carouselDot?Number(carouselDot.dataset.carouselIndex):Number(carousel.dataset.carouselIndex)+direction;
      const index=(requested+images.length)%images.length;
      carousel.dataset.carouselIndex=String(index);
      images.forEach((image,position)=>image.classList.toggle('hidden',position!==index));
      dots.forEach((dot,position)=>dot.classList.toggle('active',position===index));
      carousel.querySelector('.carousel-count').textContent=`${index+1} / ${images.length}`;
    }
    else if(like){
      const postId=like.dataset.like;
      const wasLiked=like.dataset.liked==='1';
      const data=await request(`/posts/${postId}/like`,{method:wasLiked?'DELETE':'POST'});
      like.dataset.liked=data.liked?'1':'0';
      like.setAttribute('aria-pressed',String(data.liked));
      like.classList.toggle('liked',data.liked);
      like.querySelector('span').textContent=data.liked?'♥':'♡';
      like.querySelectorAll('span')[1].textContent=data.liked?'Liked':'Like';
      updatePostCounts(postId,{likeCount:data.likeCount});
    }
    else if(save){
      const postId=save.dataset.save;
      const wasSaved=save.dataset.saved==='1';
      const data=await request(`/posts/${postId}/save`,{method:wasSaved?'DELETE':'POST'});
      save.dataset.saved=data.saved?'1':'0';
      save.setAttribute('aria-pressed',String(data.saved));
      save.classList.toggle('liked',data.saved);
      save.querySelectorAll('span')[1].textContent=data.saved?'Saved':'Save';
      toast(data.saved?'Post saved':'Removed from saved posts');
    }
    else if(comment)await openComments(comment.dataset.comment);
    else if(del&&confirm('Delete this post?')){
      await request(`/posts/${del.dataset.delete}`,{method:'DELETE'});
      del.closest('[data-post-id]')?.remove();
      state.profilePosts=state.profilePosts.filter((post)=>String(post._id||post.id||post.postId)!==del.dataset.delete);
      toast('Post deleted');
      if(state.view==='profile'){if($('#profilePostDialog').open)$('#profilePostDialog').close();await showProfile(state.currentProfile)}
    }
    else if(follow){
      follow.disabled=true;
      const isFollowing=follow.dataset.following==='true';
      const isPending=follow.dataset.relationship==='pending';
      const method=isFollowing||isPending?'DELETE':'POST';
      const result=await request(`/users/${follow.dataset.followUser}/follow`,{method});
      toast(isFollowing||isPending?(isPending?'Follow request cancelled':'You unfollowed this person'):result.status==='pending'?'Follow request sent':'You are now following this person');
      if(follow.closest('#profileConnectionsList')){
        const {username,direction}=state.connections;
        await showProfile(state.currentProfile);
        await showConnections(username,direction);
      }
      else if(state.view==='profile')await showProfile(follow.dataset.username);
      else await loadSuggestedUsers();
    }
    else if(followRequest){
      const action=followRequest.dataset.action;
      await request(`/follow-requests/${followRequest.dataset.followRequest}/${action}`,{method:'PATCH'});
      toast(action==='accept'?'Follow request accepted':'Follow request declined');
      await loadFollowRequests();
      await loadUnread();
    }
  }catch(error){toast(error.message,true)}finally{if(follow)follow.disabled=false}
});
$('#profileEditForm').addEventListener('submit',async(event)=>{
  event.preventDefault();
  const form=event.currentTarget;
  const submit=form.querySelector('[type=submit]');
  const message=$('#profileEditMessage');
  message.textContent='';
  submit.disabled=true;
  try{
    const updatedUsername=form.elements.username.value.trim().toLowerCase();
    const data=await request('/users/me',{method:'PATCH',body:JSON.stringify({name:form.elements.name.value.trim(),username:updatedUsername,email:form.elements.email.value.trim().toLowerCase(),avatarUrl:form.elements.avatarUrl.value.trim(),coverUrl:form.elements.coverUrl.value.trim(),bio:form.elements.bio.value,location:form.elements.location.value.trim(),website:form.elements.website.value.trim(),birthday:form.elements.birthday.value,pronouns:form.elements.pronouns.value.trim(),gender:form.elements.gender.value.trim(),isPrivate:form.elements.isPrivate.checked})});
    state.user={...state.user,...data.user};
    state.currentProfile=state.user.username;
    $('#sideName').textContent=state.user.name;
    $('#sideHandle').textContent=`@${state.user.username}`;
    $('#sideAvatar').innerHTML=state.user.avatarUrl?`<img src="${escapeHtml(state.user.avatarUrl)}" alt="">`:escapeHtml((state.user.name||'G').slice(0,1).toUpperCase());
    $('#composerAvatar').innerHTML=$('#sideAvatar').innerHTML;
    $('#commentAvatar').innerHTML=$('#sideAvatar').innerHTML;
    $('#profileEditDialog').close();
    toast('Profile updated');
    await showProfile(state.user.username);
  }catch(error){message.textContent=error.message;message.dataset.state='error'}
  finally{submit.disabled=false}
});
$('#profileEditForm').elements.bio.addEventListener('input',(event)=>{$('#profileBioCount').textContent=String(event.currentTarget.value.length)});
$('#postEditForm').elements.caption.addEventListener('input',(event)=>{$('#postEditCharCount').textContent=String(event.currentTarget.value.length)});
$('#postEditMedia').addEventListener('click',(event)=>{
  const remove=event.target.closest('[data-remove-edit-media]');
  if(!remove)return;
  state.editingMedia.splice(Number(remove.dataset.removeEditMedia),1);
  remove.closest('.image-preview')?.remove();
});
$('#postEditForm').addEventListener('submit',async(event)=>{
  event.preventDefault();
  if(!state.editingPostId)return;
  const form=event.currentTarget;
  const submit=form.querySelector('[type=submit]');
  const message=$('#postEditMessage');
  submit.disabled=true;
  message.textContent='';
  try{
    const body=new FormData();
    body.set('caption',form.elements.caption.value);
    body.set('location',form.elements.location.value.trim());
    body.set('mediaUrls',JSON.stringify(state.editingMedia||[]));
    await request(`/posts/${state.editingPostId}`,{method:'PATCH',body});
    $('#postEditDialog').close();
    toast('Post updated');
    if(state.view==='profile')await showProfile(state.currentProfile);
    else await loadFeed();
  }catch(error){
    message.textContent=error.message;
    message.dataset.state='error';
  }finally{
    submit.disabled=false;
  }
});
async function loadTrending(){try{const data=await request('/explore/trending');const tags=data.hashtags||[];$('#trendingList').innerHTML=tags.length?tags.map(t=>{const tag=typeof t==='string'?t:(t.tag||t.hashtag||t.name||'');const count=typeof t==='object'?(t.count||t.score||'') : '';return `<button class="trend-item" data-tag="${escapeHtml(String(tag).replace(/^#/,''))}"><span>#${escapeHtml(String(tag).replace(/^#/,''))}</span><strong>${count?escapeHtml(count):'Explore'} →</strong></button>`}).join(''):'<p class="muted tiny">No trending topics yet. Add a hashtag to your next post.</p>'}catch{$('#trendingList').innerHTML='<p class="muted tiny">Trending topics are temporarily unavailable.</p>'}}
async function loadSuggestedUsers(){
  const list=$('#suggestedUsers');
  try{
    const data=await request('/users/suggested');
    const users=(data.users||[]).filter((user)=>user.username!==state.user?.username).slice(0,5);
    list.innerHTML=users.length?users.map((user)=>`<div class="suggested-user">${avatar(user)}<button type="button" class="suggested-user-copy" data-profile="${escapeHtml(user.username)}"><strong>${escapeHtml(user.name||user.username)}</strong><span>@${escapeHtml(user.username)}</span></button><button type="button" class="follow-button" data-follow-user="${escapeHtml(user._id||user.id)}" data-username="${escapeHtml(user.username)}" data-following="false">Follow</button></div>`).join(''):'<p class="muted tiny">You’re all caught up with people to follow.</p>';
  }catch(error){list.innerHTML=`<p class="muted tiny">${escapeHtml(error.message||'Suggested people are unavailable.')}</p>`}
}
$('#trendingList').addEventListener('click',e=>{const b=e.target.closest('[data-tag]');if(b)searchPosts(b.dataset.tag,'hashtag')});
async function loadUnread(){try{const d=await request('/notifications/unread-count');const badge=$('#unreadBadge');badge.textContent=d.unreadCount||0;badge.classList.toggle('hidden',!d.unreadCount)}catch{}}
async function loadFollowRequests(){
  const panel=$('#followRequestsList');
  if(!panel)return;
  try{
    const data=await request('/follow-requests');
    const requests=data.requests||[];
    panel.innerHTML=requests.length?requests.map((request)=>`<article class="suggested-user follow-request">${avatar(request.user)}<button type="button" class="suggested-user-copy" data-profile="${escapeHtml(request.user.username)}"><strong>${escapeHtml(request.user.name||request.user.username)}</strong><span>@${escapeHtml(request.user.username)} wants to follow you</span></button><button type="button" class="follow-button" data-follow-request="${escapeHtml(request.id)}" data-action="accept">Accept</button><button type="button" class="text-button request-decline" data-follow-request="${escapeHtml(request.id)}" data-action="reject">Decline</button></article>`).join(''):'<p class="muted tiny">No pending follow requests.</p>';
  }catch(error){panel.innerHTML=`<p class="form-message" data-state="error">${escapeHtml(error.message)}</p>`}
}
async function loadAnalytics(period='30d'){
  const requestId=++state.analyticsRequest;
  const content=$('#analyticsContent');
  if(!content)return;
  content.innerHTML='<div class="empty-state"><div class="loading-spinner"></div><p>Loading analytics…</p></div>';
  try{
    const data=await request(`/users/me/analytics?period=${encodeURIComponent(period)}`);
    if(requestId!==state.analyticsRequest)return;
    const labels={'1d':'Last 24 hours','7d':'Last 7 days','30d':'Last 30 days'};
    const maximum=Math.max(1,...data.buckets.map((bucket)=>bucket.count));
    const formatter=period==='1d'
      ?new Intl.DateTimeFormat(undefined,{hour:'numeric'})
      :new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'});
    const bars=data.buckets.map((bucket,index)=>{
      const label=period==='30d'&&index%5!==0?'':formatter.format(new Date(bucket.date));
      return `<div class="analytics-bar" title="${escapeHtml(formatter.format(new Date(bucket.date)))}: ${bucket.count} views"><i style="height:${Math.round(bucket.count/maximum*100)}%"></i><small>${escapeHtml(label)}</small></div>`;
    }).join('');
    content.innerHTML=`<div class="analytics-heading"><div><p class="eyebrow">PROFILE PERFORMANCE</p><h2>Social analytics</h2></div><label class="analytics-period-label"><span class="visually-hidden">Analytics date range</span><select id="analyticsPeriod"><option value="1d"${period==='1d'?' selected':''}>Last day</option><option value="7d"${period==='7d'?' selected':''}>Last 7 days</option><option value="30d"${period==='30d'?' selected':''}>Last 30 days</option></select></label></div><div class="analytics-metrics"><article><span class="metric-icon gold">▥</span><div><small>Profile views</small><strong>${Number(data.profileViews).toLocaleString()}</strong></div></article><article><span class="metric-icon coral">◎</span><div><small>Followers</small><strong>${Number(data.followers).toLocaleString()}</strong></div></article><article><span class="metric-icon violet">◇</span><div><small>Following</small><strong>${Number(data.following).toLocaleString()}</strong></div></article><article><span class="metric-icon mint">♥</span><div><small>Community</small><strong>${(Number(data.followers)+Number(data.following)).toLocaleString()}</strong></div></article></div><div class="analytics-grid"><article class="analytics-card"><div class="analytics-card-head"><div><small>Unique visitors</small><h3>Profile views · ${labels[period]}</h3></div></div><div class="analytics-bars">${bars}</div></article><article class="analytics-card analytics-note"><div class="analytics-card-head"><div><small>How this is counted</small><h3>Real profile visits</h3></div></div><p>Views count when another signed-in member visits your profile. The same person counts once per day, so refreshing won’t inflate your total.</p></article></div>`;
    $('#analyticsPeriod').addEventListener('change',(event)=>loadAnalytics(event.currentTarget.value));
  }catch(error){
    if(requestId===state.analyticsRequest)content.innerHTML=`<div class="empty-state"><strong>Couldn't load analytics</strong><p>${escapeHtml(error.message)}</p><button class="button button-light" type="button" data-retry-analytics="${escapeHtml(period)}">Try again</button></div>`;
  }
}
async function loadConnectionPage(append=false){
  const connections=state.connections;
  if(!connections||connections.loading)return;
  connections.loading=true;
  const list=$('#profileConnectionsList');
  if(!append)list.innerHTML='<div class="empty-state"><div class="loading-spinner"></div><p>Loading people…</p></div>';
  try{
    const query=new URLSearchParams({limit:'30'});
    if(append&&connections.cursor)query.set('cursor',connections.cursor);
    const data=await request(`/users/${encodeURIComponent(connections.username)}/${connections.direction}?${query}`);
    connections.cursor=data.nextCursor||null;
    const users=data.items||[];
    const rows=users.map((user)=>{
      const relationship=user.relationship||'none';
      const followButton=user._id===state.user?.id?'':`<button type="button" class="follow-button" data-follow-user="${escapeHtml(user._id)}" data-username="${escapeHtml(user.username)}" data-following="${relationship==='accepted'}" data-relationship="${escapeHtml(relationship)}">${relationship==='accepted'?'Following':relationship==='pending'?'Requested':'Follow'}</button>`;
      return `<article class="suggested-user connection-user">${avatar(user)}<button type="button" class="suggested-user-copy" data-profile="${escapeHtml(user.username)}"><strong>${escapeHtml(user.name||user.username)}</strong><span>@${escapeHtml(user.username)}</span></button>${followButton}</article>`;
    }).join('');
    if(!append)list.innerHTML=rows||'<div class="empty-state"><p>No people to show yet.</p></div>';
    else list.insertAdjacentHTML('beforeend',rows);
    $('#profileConnectionsMore').classList.toggle('hidden',!connections.cursor);
  }catch(error){
    if(!append)list.innerHTML=`<div class="empty-state"><strong>Couldn't load people</strong><p>${escapeHtml(error.message)}</p><button class="button button-light" type="button" data-retry-connections>Try again</button></div>`;
    else toast(error.message,true);
  }finally{
    connections.loading=false;
  }
}
async function showConnections(username,direction){
  state.connections={username,direction,cursor:null,loading:false};
  $('#profileConnectionsTitle').textContent=direction==='followers'?'Followers':'Following';
  $('#profileConnectionsMore').classList.add('hidden');
  $('#profileConnectionsDialog').showModal();
  await loadConnectionPage();
}
function navigate(view){
  state.view=view;
  document.querySelectorAll('[data-view]').forEach((button)=>button.classList.toggle('active',button.dataset.view===view));
  $('#pageTitle').textContent=view==='feed'?'Home feed':view==='explore'?'Explore':view==='analytics'?'Analytics':'Notifications';
  $('#pageEyebrow').textContent=view==='feed'?'YOUR COMMUNITY':view==='explore'?'FIND YOUR PEOPLE':view==='analytics'?'YOUR PERFORMANCE':'STAY IN THE LOOP';
  $('#appView').classList.toggle('hidden',view!=='feed');
  $('#simpleView').classList.toggle('hidden',view==='feed');
  if(view==='feed'){loadFeed();return}
  const box=$('#simpleContent');
  if(view==='explore'){
    box.innerHTML='<p class="eyebrow">DISCOVER SOMETHING NEW</p><h2>Explore the community</h2><p class="muted">Find creators, photos, and hashtags.</p><form id="searchForm" class="search-form"><input name="q" placeholder="Search people or topics…" required><select name="type"><option value="user">People</option><option value="post">Posts</option><option value="hashtag">Hashtags</option></select><button class="button button-primary">Search →</button></form><div id="searchResults"></div>';
    $('#searchForm').addEventListener('submit',(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);searchPosts(form.get('q'),form.get('type'))});
  }else if(view==='analytics'){
    box.innerHTML='<section id="analyticsContent" class="analytics-view"></section>';
    loadAnalytics();
  }else{
    box.innerHTML='<div class="rail-heading"><div><p class="eyebrow">YOUR ACTIVITY</p><h2>Notifications</h2></div><button id="readAll" class="button button-light">Mark all read</button></div><section class="requests-section"><h3>Follow requests</h3><div id="followRequestsList"><p class="muted tiny">Loading requests…</p></div></section><div id="notificationsList"><div class="empty-state"><div class="loading-spinner"></div><p>Loading notifications…</p></div></div>';
    $('#readAll').addEventListener('click',async()=>{try{await request('/notifications/read-all',{method:'PATCH'});await loadNotifications();await loadUnread()}catch(error){toast(error.message,true)}});
    loadNotifications();
    loadFollowRequests();
  }
}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
async function showProfile(username){
  if(!username)return;
  state.view='profile';
  state.currentProfile=username;
  document.querySelectorAll('[data-view]').forEach((button)=>button.classList.remove('active'));
  $('#pageTitle').textContent=`@${username}`;
  $('#pageEyebrow').textContent='COMMUNITY PROFILE';
  $('#appView').classList.add('hidden');
  $('#simpleView').classList.remove('hidden');
  const box=$('#simpleContent');
  box.innerHTML='<div class="empty-state"><div class="loading-spinner"></div><p>Loading profile…</p></div>';
  try{
    const {user,isSelf,relationship,postCount}=await request(`/users/${encodeURIComponent(username)}`);
    if(isSelf)state.user={...state.user,...user};
    const userId=user._id||user.id;
    const following=relationship==='accepted'||relationship==='pending';
    const profileDetails=[user.pronouns,user.gender].filter(Boolean).map((detail)=>`<span>${escapeHtml(detail)}</span>`).join('');
    const website=user.website?`<a class="profile-website" href="${escapeHtml(user.website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(user.website.replace(/^https?:\/\//i,'').replace(/\/$/,''))}</a>`:'';
    const location=user.location?`<span class="profile-location">⌖ ${escapeHtml(user.location)}</span>`:'';
    const cover=user.coverUrl?`<div class="profile-cover"><img src="${escapeHtml(user.coverUrl)}" alt=""></div>`:'';
    const profileHeader=`<section class="profile-header">${cover}<div class="profile-avatar-wrap">${avatar(user)}</div><div class="profile-info"><div class="profile-title"><h2>${escapeHtml(user.name||user.username)}</h2>${isSelf?'<button type="button" class="button button-light profile-edit-button" data-edit-profile>Edit profile</button><button type="button" class="button button-light profile-share-button" data-share-profile>Share profile</button>':`<button type="button" class="follow-button profile-follow" data-follow-user="${escapeHtml(userId)}" data-username="${escapeHtml(user.username)}" data-following="${relationship==='accepted'}" data-relationship="${escapeHtml(relationship)}">${relationship==='accepted'?'Following':relationship==='pending'?'Requested':'Follow'}</button><button type="button" class="button button-light profile-share-button" data-share-profile>Share profile</button>`}</div><p class="profile-handle">@${escapeHtml(user.username)}</p><div class="profile-stats"><span><strong>${postCount??'—'}</strong><small>posts</small></span><button type="button" class="profile-stat-link" data-profile-list="followers" data-username="${escapeHtml(user.username)}"><strong>${Number(user.followerCount||0)}</strong><small>followers</small></button><button type="button" class="profile-stat-link" data-profile-list="following" data-username="${escapeHtml(user.username)}"><strong>${Number(user.followingCount||0)}</strong><small>following</small></button></div><p class="profile-bio">${escapeHtml(user.bio||'Sharing little moments and good things.')}</p>${profileDetails||location||website?`<div class="profile-extra-details">${profileDetails}${location}${website}</div>`:''}${user.isPrivate?'<span class="profile-private-badge">Private account</span>':''}</div></section><div class="profile-post-heading"><span class="profile-tab active"><span>▦</span> Posts</span></div>`;
    if(isSelf||!user.isPrivate||relationship==='accepted'){
      const data=await request(`/users/${encodeURIComponent(username)}/posts?limit=30`);
      const posts=data.items||[];
      state.profilePosts=posts;
      const photoPosts=posts.filter((post)=>Array.isArray(post.media)&&post.media.some((item)=>item.url));
      const tiles=photoPosts.map((post)=>{
        const id=post._id||post.id||post.postId;
        const media=post.media.filter((item)=>item.url);
        return `<button type="button" class="profile-grid-tile" data-profile-post="${escapeHtml(id||'')}" aria-label="View post by ${escapeHtml(user.username)}"><img src="${escapeHtml(media[0].url)}" alt="${escapeHtml(post.caption||'Photo post')}" loading="lazy"><span class="profile-grid-overlay"><span>♥ ${Number(post.likeCount||0)}</span><span>▤ ${Number(post.commentCount||0)}</span></span>${media.length>1?'<span class="profile-multi-mark" aria-label="Multiple photos">▧</span>':''}</button>`;
      }).join('');
      box.innerHTML=profileHeader+(photoPosts.length?`<div id="profilePostGrid" class="profile-post-grid">${tiles}</div>`:`<div class="empty-state profile-empty"><strong>No post yet</strong><p>Posts from this profile will appear here.</p>${isSelf?'<button type="button" class="button button-primary" data-profile-create>Share your first post</button>':''}</div>`);
    }else{
      state.profilePosts=[];
      box.innerHTML=profileHeader+`<div class="empty-state private-profile"><strong>${relationship==='pending'?'Follow request sent':'This account is private'}</strong><p>${relationship==='pending'?'Your request is waiting for approval.':'Follow this account to see their photos and posts.'}</p></div>`;
    }
  }catch(error){box.innerHTML=`<div class="empty-state"><strong>Couldn't load this profile</strong><p>${escapeHtml(error.message)}</p><button class="button button-light" data-go-feed>Back to feed</button></div>`}
}
async function searchPosts(q,type){
  const results=$('#searchResults');
  if(!results)return;
  results.innerHTML='<p class="muted">Searching…</p>';
  try{
    const data=await request(`/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}`);
    if(type==='user'){
      const users=data.users||[];
      results.innerHTML=users.length?`<div class="search-people">${users.map((user)=>`<article class="suggested-user search-user">${avatar(user)}<button type="button" class="suggested-user-copy" data-profile="${escapeHtml(user.username)}"><strong>${escapeHtml(user.name||user.username)}</strong><span>@${escapeHtml(user.username)} · ${Number(user.followerCount||0)} followers</span></button>${user.username===state.user?.username?'':`<button type="button" class="follow-button" data-follow-user="${escapeHtml(user._id||user.id)}" data-username="${escapeHtml(user.username)}" data-following="false">Follow</button>`}</article>`).join('')}</div>`:'<p class="muted">No matching people found.</p>';
    }else{
      const posts=data.posts||[];
      results.innerHTML=posts.length?`<div class="feed-list">${posts.map(postCard).join('')}</div>`:'<p class="muted">No matching posts found.</p>';
    }
  }catch(error){results.innerHTML=`<p class="form-message" data-state="error">${escapeHtml(error.message)}</p>`}
}
async function loadNotifications(){const list=$('#notificationsList');if(!list)return;try{const data=await request('/notifications?limit=20');const items=data.items||[];list.innerHTML=items.length?items.map(n=>{const actors=(n.actors||[]).map(a=>a.name||a.username).filter(Boolean).join(', ');const text=n.type==='like'?'liked your post':n.type==='comment'?'commented on your post':n.type==='follow'?'started following you':n.type==='reply'?'replied to your comment':`sent you a ${n.type||'notification'}`;return `<div class="notification-row"><strong>${escapeHtml(actors||'Someone')}</strong> ${escapeHtml(text)} <span class="muted">· ${escapeHtml(dateLabel(n.updatedAt||n.createdAt))}</span>${n.readAt?'':' <span class="count">NEW</span>'}</div>`}).join(''):'<div class="empty-state"><div class="empty-icon">♡</div><strong>All caught up.</strong><p>New activity from your community will show up here.</p></div>'}catch(err){list.innerHTML=`<p class="form-message">${escapeHtml(err.message)}</p>`}}
async function init(){if(!state.accessToken){showSignedOut();return}try{const data=await request('/auth/me');state.user=data.user;showSignedIn()}catch{showSignedOut()}}
if(window.io){try{const socket=window.io();socket.on('notification:new',()=>{loadUnread();toast('You have a new notification')})}catch{}}
init();
