import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../utils/errors.js';

const uploadsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/uploads');
const localImageExtensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (localImageExtensions[file.mimetype]) return cb(null, true);
    cb(new ApiError(400, 'Choose a JPEG, PNG, WebP, or GIF image'));
  },
});

const uploadToCloudinary = (file) =>
  new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder: 'socialfeed', transformation: [{ width: 1600, crop: 'limit' }] }, (err, result) =>
        err ? reject(err) : resolve({ url: result.secure_url, publicId: result.public_id, width: result.width, height: result.height })
      )
      .end(file.buffer);
  });

const uploadLocally = async (file) => {
  const filename = `${randomUUID()}${localImageExtensions[file.mimetype]}`;
  await mkdir(uploadsDir, { recursive: true });
  await writeFile(path.join(uploadsDir, filename), file.buffer, { flag: 'wx' });
  return { url: `/uploads/${filename}`, publicId: `local:${filename}` };
};

export const uploadImage = (file) => (process.env.CLOUDINARY_URL ? uploadToCloudinary(file) : uploadLocally(file));
