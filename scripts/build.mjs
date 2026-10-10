import { mkdir, copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = process.cwd();
const target = resolve(root, 'dist');
if (target !== resolve(root, 'dist')) throw new Error('Invalid output directory');
await rm(target, { recursive: true, force: true });
await mkdir(resolve(target, 'icons'), { recursive: true });
const files = ['index.html', 'dashboard.html', 'styles.css', 'dashboard.css', 'shared.js', 'app.js',
  'dashboard.js', 'supabase-config.js', 'pwa.js', 'sw.js', 'manifest.webmanifest', 'offline.html',
  'icons/icon-192.png', 'icons/icon-512.png'];
await Promise.all(files.map((file) => copyFile(resolve(root, file), resolve(target, file))));
console.log('Site statique prêt dans dist/ (aucun fichier SQL, test ou dépendance publié).');
