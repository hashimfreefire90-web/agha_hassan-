'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = __dirname;
const DATA_DIR = process.env.AHMC_DATA_DIR || path.join(__dirname, '.private');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CARS_FILE = path.join(DATA_DIR, 'cars.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SESSION_COOKIE = 'ahmc_session';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const attempts = new Map();
const allowedPages = new Set(['index.html', 'agha-hassan.html', 'login.html']);
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

async function readUsers() {
  try { return JSON.parse(await fs.readFile(USERS_FILE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function saveUsers(users) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = USERS_FILE + '.tmp';
  await fs.writeFile(temp, JSON.stringify(users, null, 2), { mode: 0o600 });
  await fs.rename(temp, USERS_FILE);
}
async function readCars() {
  try { return JSON.parse(await fs.readFile(CARS_FILE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function saveCars(cars) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = CARS_FILE + '.tmp';
  await fs.writeFile(temp, JSON.stringify(cars, null, 2), { mode: 0o600 });
  await fs.rename(temp, CARS_FILE);
}
async function readOrders() {
  try { return JSON.parse(await fs.readFile(ORDERS_FILE, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function saveOrders(orders) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = ORDERS_FILE + '.tmp';
  await fs.writeFile(temp, JSON.stringify(orders, null, 2), { mode: 0o600 });
  await fs.rename(temp, ORDERS_FILE);
}
function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}
function cookieOptions(req, maxAge) {
  const secure = process.env.NODE_ENV === 'production' || Boolean(req.socket.encrypted);
  return 'Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secure ? '; Secure' : '');
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim().split(/=(.*)/s)).filter(parts => parts.length > 1).map(([key, value]) => [key, decodeURIComponent(value || '')]));
}
function sessionFor(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; }
  return { token, ...session };
}
function newSession(req, res, userId) {
  for (const [token, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(token);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL });
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + token + '; ' + cookieOptions(req, SESSION_TTL / 1000));
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function rateLimit(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let record = attempts.get(key);
  if (!record || now - record.startedAt > 15 * 60 * 1000) record = { startedAt: now, count: 0 };
  record.count += 1;
  attempts.set(key, record);
  return record.count <= 12;
}
async function readJson(req, maxBytes = 16_384) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  }
  try { return JSON.parse(raw || '{}'); }
  catch { throw Object.assign(new Error('Please send valid form data.'), { status: 400 }); }
}
function publicUser(user) { return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt, hasAvatar: Boolean(user.avatarExt) }; }
function publicCar(car, userId = null) {
  const imageExts = car.imageExts || [car.imageExt];
  const imageUrls = imageExts.filter(Boolean).map((_, index) => '/api/cars/' + car.id + '/image/' + (index + 1));
  return { id: car.id, title: car.title, year: car.year, price: car.price, category: car.category, mileage: car.mileage, transmission: car.transmission, engine: car.engine, color: car.color, drivetrain: car.drivetrain, description: car.description, tag: car.tag, imageUrl: imageUrls[0], imageUrls, createdAt: car.createdAt, isOwner: Boolean(userId && car.ownerId === userId) };
}
function decodeCarImages(photos, required = true) {
  if (!Array.isArray(photos) || (required && !photos.length) || photos.length > 10) throw Object.assign(new Error(required ? 'Add between 1 and 10 car photos.' : 'Choose no more than 10 car photos.'), { status: 400 });
  const images = [];
  for (const photo of photos) {
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(photo || ''));
    if (!match) throw Object.assign(new Error('Use JPG, PNG, or WebP car photos.'), { status: 400 });
    const imageType = match[1], image = Buffer.from(match[2], 'base64');
    const validImage = imageType === 'jpeg' ? image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff : imageType === 'png' ? image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image.length > 12 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
    if (!validImage || !image.length || image.length > 1_048_576) throw Object.assign(new Error('Each car photo must be a valid image smaller than 1 MB after compression.'), { status: 400 });
    images.push({ image, extension: imageType === 'jpeg' ? 'jpg' : imageType });
  }
  return images;
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve({ salt, hash: key.toString('hex') })));
}
async function authenticate(email, password) {
  const users = await readUsers();
  const user = users.find(entry => entry.email === email);
  // Do the same expensive hash operation for missing email addresses as well.
  const stored = user || { passwordSalt: 'aghahassanmotorsalt', passwordHash: crypto.scryptSync('not-a-real-password', 'aghahassanmotorsalt', 64).toString('hex') };
  const candidate = await hashPassword(password, stored.passwordSalt);
  const a = Buffer.from(candidate.hash, 'hex');
  const b = Buffer.from(stored.passwordHash, 'hex');
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);
  return user && matches ? user : null;
}
async function handleApi(req, res, url) {
  if (!sameOrigin(req) && req.method !== 'GET') return sendJson(res, 403, { error: 'Request origin was not accepted.' });
  if (url.pathname === '/api/orders' && req.method === 'POST') {
    const data = await readJson(req, 16_384);
    const customerName = String(data.name || '').trim().replace(/\s+/g, ' ');
    const customerEmail = String(data.email || '').trim().toLowerCase();
    const customerPhone = String(data.phone || '').trim();
    const interest = String(data.interest || '').trim();
    const notes = String(data.message || '').trim();
    if (customerName.length < 2 || customerName.length > 100) return sendJson(res, 400, { error: 'Enter your name (2 to 100 characters).' });
    if (customerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    if (customerPhone.length > 40 || interest.length > 100 || notes.length > 2000) return sendJson(res, 400, { error: 'One of the fields is too long. Please shorten it and try again.' });
    let car = null;
    if (data.carId) {
      car = (await readCars()).find(entry => entry.id === String(data.carId));
      if (!car) return sendJson(res, 404, { error: 'That car is no longer listed. Refresh the page and choose another.' });
    }
    const orders = await readOrders();
    if (orders.length >= 10_000) return sendJson(res, 503, { error: 'The request list is full. Please contact the club directly.' });
    const id = crypto.randomUUID();
    const order = { id, reference: 'AH-' + id.slice(0, 8).toUpperCase(), carId: car?.id || null, carTitle: car?.title || '', carYear: car?.year || null, carPrice: car?.price || null, customerName, customerEmail, customerPhone, interest, notes, status: 'Pending', createdAt: new Date().toISOString() };
    orders.unshift(order);
    await saveOrders(orders);
    return sendJson(res, 201, { order: { reference: order.reference, status: order.status, carTitle: order.carTitle } });
  }
  if (url.pathname === '/api/orders' && req.method === 'GET') {
    const session = sessionFor(req);
    const users = await readUsers();
    const owner = users.reduce((first, user) => !first || user.createdAt < first.createdAt ? user : first, null);
    if (!session || !owner || session.userId !== owner.id) return sendJson(res, 403, { error: 'Only the club owner can view incoming requests.' });
    const orders = await readOrders();
    return sendJson(res, 200, { orders });
  }
  const orderRoute = /^\/api\/orders\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (orderRoute && req.method === 'DELETE') {
    const session = sessionFor(req);
    const users = await readUsers();
    const owner = users.reduce((first, user) => !first || user.createdAt < first.createdAt ? user : first, null);
    if (!session || !owner || session.userId !== owner.id) return sendJson(res, 403, { error: 'Only the club owner can delete saved requests.' });
    const orders = await readOrders();
    const orderIndex = orders.findIndex(order => order.id === orderRoute[1]);
    if (orderIndex < 0) return sendJson(res, 404, { error: 'Saved request not found. Refresh the list and try again.' });
    orders.splice(orderIndex, 1);
    await saveOrders(orders);
    return sendJson(res, 200, { orders });
  }
  if (url.pathname === '/api/cars' && req.method === 'GET') {
    const cars = await readCars();
    return sendJson(res, 200, { cars: cars.map(car => publicCar(car, sessionFor(req)?.userId)) });
  }
  const carImageRoute = /^\/api\/cars\/([0-9a-f-]{36})\/image(?:\/(\d+))?$/.exec(url.pathname);
  if (carImageRoute && req.method === 'GET') {
    const car = (await readCars()).find(entry => entry.id === carImageRoute[1]);
    if (!car) return sendJson(res, 404, { error: 'Car photo not found.' });
    const imageExts = car.imageExts || [car.imageExt];
    const index = Math.max(0, Number(carImageRoute[2] || 1) - 1);
    const extension = imageExts[index];
    if (!extension) return sendJson(res, 404, { error: 'Car photo not found.' });
    const file = car.imageExts ? path.join(DATA_DIR, 'car-' + car.id + '-' + (index + 1) + '.' + extension) : path.join(DATA_DIR, 'car-' + car.id + '.' + extension);
    const image = await fs.readFile(file);
    const imageType = extension === 'jpg' ? 'image/jpeg' : 'image/' + extension;
    res.writeHead(200, { 'Content-Type': imageType, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    return res.end(image);
  }
  if (url.pathname === '/api/cars' && req.method === 'POST') {
    const session = sessionFor(req);
    if (!session) return sendJson(res, 401, { error: 'Please sign in to add a car.' });
    const users = await readUsers();
    if (!users.some(entry => entry.id === session.userId)) return sendJson(res, 401, { error: 'Please sign in.' });
    const data = await readJson(req, 15_000_000);
    const title = String(data.title || '').trim().replace(/\s+/g, ' ');
    const category = String(data.category || '').toLowerCase();
    const year = Number(data.year), price = Number(data.price), mileage = Number(data.mileage || 0);
    if (title.length < 3 || title.length > 90) return sendJson(res, 400, { error: 'Enter a car name between 3 and 90 characters.' });
    if (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1) return sendJson(res, 400, { error: 'Enter a valid model year.' });
    if (!Number.isFinite(price) || price < 1 || price > 100_000_000) return sendJson(res, 400, { error: 'Enter a valid asking price.' });
    if (!Number.isFinite(mileage) || mileage < 0 || mileage > 2_000_000) return sendJson(res, 400, { error: 'Enter valid mileage.' });
    if (!['sport', 'suv', 'classic'].includes(category)) return sendJson(res, 400, { error: 'Choose Sport, SUV, or Classics.' });
    for (const [key, label, max] of [['transmission','Transmission',40],['engine','Engine',60],['color','Color',50],['drivetrain','Drivetrain',30],['description','Description',300],['tag','Listing label',24]]) {
      if (String(data[key] || '').trim().length > max) return sendJson(res, 400, { error: label + ' is too long.' });
    }
    const photos = Array.isArray(data.images) ? data.images : (data.image ? [data.image] : []);
    let images;
    try { images = decodeCarImages(photos); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    const cars = await readCars();
    if (cars.length >= 100) return sendJson(res, 409, { error: 'The collection has reached its 100-car limit.' });
    const id = crypto.randomUUID(), imageExts = images.map(entry => entry.extension);
    const car = { id, ownerId: session.userId, title, year, price, category, mileage, transmission: String(data.transmission || 'Automatic').trim(), engine: String(data.engine || '').trim(), color: String(data.color || '').trim(), drivetrain: String(data.drivetrain || '').trim(), description: String(data.description || '').trim(), tag: String(data.tag || 'New arrival').trim(), imageExts, createdAt: new Date().toISOString() };
    await fs.mkdir(DATA_DIR, { recursive: true });
    for (let index = 0; index < images.length; index++) await fs.writeFile(path.join(DATA_DIR, 'car-' + id + '-' + (index + 1) + '.' + imageExts[index]), images[index].image, { mode: 0o600 });
    cars.push(car); await saveCars(cars);
    return sendJson(res, 201, { car: publicCar(car, session.userId) });
  }
  const carRoute = /^\/api\/cars\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (carRoute && req.method === 'PUT') {
    const session = sessionFor(req);
    if (!session) return sendJson(res, 401, { error: 'Please sign in.' });
    const cars = await readCars(), car = cars.find(entry => entry.id === carRoute[1]);
    if (!car) return sendJson(res, 404, { error: 'Car listing not found.' });
    if (car.ownerId !== session.userId) return sendJson(res, 403, { error: 'You can only edit your own car listings.' });
    const data = await readJson(req, 15_000_000);
    const title = String(data.title || '').trim().replace(/\s+/g, ' '), category = String(data.category || '').toLowerCase();
    const year = Number(data.year), price = Number(data.price), mileage = Number(data.mileage || 0);
    if (title.length < 3 || title.length > 90) return sendJson(res, 400, { error: 'Enter a car name between 3 and 90 characters.' });
    if (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 1) return sendJson(res, 400, { error: 'Enter a valid model year.' });
    if (!Number.isFinite(price) || price < 1 || price > 100_000_000) return sendJson(res, 400, { error: 'Enter a valid asking price.' });
    if (!Number.isFinite(mileage) || mileage < 0 || mileage > 2_000_000) return sendJson(res, 400, { error: 'Enter valid mileage.' });
    if (!['sport', 'suv', 'classic'].includes(category)) return sendJson(res, 400, { error: 'Choose Sport, SUV, or Classics.' });
    for (const [key, label, max] of [['transmission','Transmission',40],['engine','Engine',60],['color','Color',50],['drivetrain','Drivetrain',30],['description','Description',300],['tag','Listing label',24]]) {
      if (String(data[key] || '').trim().length > max) return sendJson(res, 400, { error: label + ' is too long.' });
    }
    const incomingPhotos = Array.isArray(data.images) ? data.images : [];
    let newImages;
    try { newImages = decodeCarImages(incomingPhotos, false); } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    const legacySingleImage = !car.imageExts;
    const oldExtensions = car.imageExts || [car.imageExt];
    const replaceImages = Boolean(data.replaceImages) && newImages.length > 0;
    let keptOldIndexes = oldExtensions.map((_, index) => index);
    if (!replaceImages && Array.isArray(data.keepPhotoIndexes)) {
      keptOldIndexes = [...new Set(data.keepPhotoIndexes.map(Number))];
      if (keptOldIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= oldExtensions.length)) return sendJson(res, 400, { error: 'The photo selection is invalid. Please refresh and try again.' });
    }
    const finalExtensions = replaceImages ? newImages.map(entry => entry.extension) : newImages.map(entry => entry.extension).concat(keptOldIndexes.map(index => oldExtensions[index]));
    if (!finalExtensions.length) return sendJson(res, 400, { error: 'Keep or add at least one photo for this car.' });
    if (finalExtensions.length > 10) return sendJson(res, 400, { error: 'A car can have up to 10 photos. Choose fewer new photos or replace the gallery.' });
    const oldFiles = oldExtensions.map((extension, index) => car.imageExts ? path.join(DATA_DIR, 'car-' + car.id + '-' + (index + 1) + '.' + extension) : path.join(DATA_DIR, 'car-' + car.id + '.' + extension));
    await fs.mkdir(DATA_DIR, { recursive: true });
    const keptImages = replaceImages ? [] : await Promise.all(keptOldIndexes.map(async index => fs.readFile(oldFiles[index])));
    const allImages = replaceImages ? newImages.map(entry => entry.image) : newImages.map(entry => entry.image).concat(keptImages);
    const tempFiles = [];
    for (let index = 0; index < allImages.length; index++) {
      const tempFile = path.join(DATA_DIR, 'car-' + car.id + '-edit-' + crypto.randomUUID());
      await fs.writeFile(tempFile, allImages[index], { mode: 0o600 });
      tempFiles.push(tempFile);
    }
    for (const file of oldFiles) await fs.unlink(file).catch(() => {});
    for (let index = 0; index < tempFiles.length; index++) await fs.rename(tempFiles[index], path.join(DATA_DIR, 'car-' + car.id + '-' + (index + 1) + '.' + finalExtensions[index]));
    Object.assign(car, { title, year, price, category, mileage, transmission: String(data.transmission || 'Automatic').trim(), engine: String(data.engine || '').trim(), color: String(data.color || '').trim(), drivetrain: String(data.drivetrain || '').trim(), description: String(data.description || '').trim(), tag: String(data.tag || car.tag || 'New arrival').trim(), imageExts: finalExtensions });
    delete car.imageExt;
    await saveCars(cars);
    if (legacySingleImage && oldFiles[0]) await fs.unlink(oldFiles[0]).catch(() => {});
    return sendJson(res, 200, { car: publicCar(car, session.userId) });
  }
  if (carRoute && req.method === 'DELETE') {
    const session = sessionFor(req);
    if (!session) return sendJson(res, 401, { error: 'Please sign in.' });
    const cars = await readCars(), index = cars.findIndex(entry => entry.id === carRoute[1]);
    if (index < 0) return sendJson(res, 404, { error: 'Car listing not found.' });
    if (cars[index].ownerId !== session.userId) return sendJson(res, 403, { error: 'You can only remove your own car listings.' });
    const [car] = cars.splice(index, 1); await saveCars(cars);
    for (let index = 0; index < (car.imageExts || [car.imageExt]).length; index++) {
      const extension = (car.imageExts || [car.imageExt])[index];
      await fs.unlink(path.join(DATA_DIR, 'car-' + car.id + '-' + (index + 1) + '.' + extension)).catch(() => {});
      if (!car.imageExts) await fs.unlink(path.join(DATA_DIR, 'car-' + car.id + '.' + extension)).catch(() => {});
    }
    return sendJson(res, 200, { cars: cars.filter(entry => entry.ownerId === session.userId).map(entry => publicCar(entry, session.userId)) });
  }
  if (url.pathname === '/api/avatar') {
    const session = sessionFor(req);
    if (!session) return sendJson(res, 401, { error: 'Please sign in.' });
    const users = await readUsers();
    const user = users.find(entry => entry.id === session.userId);
    if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
    if (req.method === 'GET') {
      if (!user.avatarExt) return sendJson(res, 404, { error: 'No profile photo has been added.' });
      const file = path.join(DATA_DIR, 'avatar-' + user.id + '.' + user.avatarExt);
      const image = await fs.readFile(file);
      const imageType = user.avatarExt === 'jpg' ? 'image/jpeg' : 'image/' + user.avatarExt;
      res.writeHead(200, { 'Content-Type': imageType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(image);
    }
    if (req.method === 'POST') {
      const data = await readJson(req, 1_500_000);
      const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(data.image || ''));
      if (!match) return sendJson(res, 400, { error: 'Choose a JPG, PNG, or WebP image.' });
      const imageType = match[1];
      const image = Buffer.from(match[2], 'base64');
      if (!image.length || image.length > 1_048_576) return sendJson(res, 413, { error: 'Choose a photo smaller than 1 MB.' });
      const validImage = imageType === 'jpeg' ? image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff : imageType === 'png' ? image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image.length > 12 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
      if (!validImage) return sendJson(res, 400, { error: 'That image file could not be read.' });
      const extension = imageType === 'jpeg' ? 'jpg' : imageType;
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(path.join(DATA_DIR, 'avatar-' + user.id + '.' + extension), image, { mode: 0o600 });
      const previousExtension = user.avatarExt;
      user.avatarExt = extension;
      await saveUsers(users);
      if (previousExtension && previousExtension !== extension) await fs.unlink(path.join(DATA_DIR, 'avatar-' + user.id + '.' + previousExtension)).catch(() => {});
      return sendJson(res, 200, { user: publicUser(user) });
    }
    if (req.method === 'DELETE') {
      const previousExtension = user.avatarExt;
      delete user.avatarExt;
      await saveUsers(users);
      if (previousExtension) await fs.unlink(path.join(DATA_DIR, 'avatar-' + user.id + '.' + previousExtension)).catch(() => {});
      return sendJson(res, 200, { user: publicUser(user) });
    }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  if (!sameOrigin(req) && req.method !== 'GET') return sendJson(res, 403, { error: 'Request origin was not accepted.' });
  if (url.pathname === '/api/me' && req.method === 'GET') {
    const session = sessionFor(req);
    if (!session) return sendJson(res, 401, { error: 'Please sign in.' });
    const user = (await readUsers()).find(entry => entry.id === session.userId);
    if (!user) { sessions.delete(session.token); return sendJson(res, 401, { error: 'Please sign in.' }); }
    return sendJson(res, 200, { user: publicUser(user) });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const session = sessionFor(req);
    if (session) sessions.delete(session.token);
    res.setHeader('Set-Cookie', SESSION_COOKIE + '=; ' + cookieOptions(req, 0));
    return sendJson(res, 200, { ok: true });
  }
  if (!['/api/login', '/api/register'].includes(url.pathname) || req.method !== 'POST') return sendJson(res, 404, { error: 'That page was not found.' });
  if (!rateLimit(req)) return sendJson(res, 429, { error: 'Too many tries. Please wait 15 minutes and try again.' });
  const data = await readJson(req);
  const email = String(data.email || '').trim().toLowerCase();
  const password = String(data.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return sendJson(res, 400, { error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 128) return sendJson(res, 400, { error: 'Password must be between 8 and 128 characters.' });

  if (url.pathname === '/api/register') {
    const name = String(data.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 70) return sendJson(res, 400, { error: 'Enter your name (2 to 70 characters).' });
    const users = await readUsers();
    if (users.some(user => user.email === email)) return sendJson(res, 409, { error: 'An account already uses this email. Sign in instead.' });
    const credentials = await hashPassword(password);
    const user = { id: crypto.randomUUID(), name, email, passwordSalt: credentials.salt, passwordHash: credentials.hash, createdAt: new Date().toISOString() };
    users.push(user);
    await saveUsers(users);
    newSession(req, res, user.id);
    return sendJson(res, 201, { user: publicUser(user) });
  }
  const user = await authenticate(email, password);
  if (!user) return sendJson(res, 401, { error: 'Email or password is incorrect.' });
  newSession(req, res, user.id);
  return sendJson(res, 200, { user: publicUser(user) });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' https: data: blob:; media-src 'self' https://videos.pexels.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
    let requested = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!requested || requested.endsWith('/')) requested += 'index.html';
    if (!allowedPages.has(requested)) return sendJson(res, 404, { error: 'Page not found.' });
    const file = path.join(PUBLIC_DIR, requested);
    const content = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(file)], 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    return res.end(content);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    return sendJson(res, status, { error: status >= 500 ? 'Something went wrong. Please try again.' : error.message });
  }
});

server.listen(PORT, HOST, () => console.log('Agha Hassan Motor Club is running at http://' + HOST + ':' + PORT));
