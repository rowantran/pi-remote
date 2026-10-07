import { getNativeClipboard, type NativeClipboard } from '@earendil-works/pi-tui';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAttachment, imageMimeType, MAX_IMAGE_BYTES, type Attachment } from './files.js';
import { shellQuote } from './client.js';

/** Invoked only by an explicit local paste action. Never reads the clipboard on startup. */
export async function readLocalClipboard(clipboard: NativeClipboard | undefined = getNativeClipboard()): Promise<{attachments:Attachment[];text?:string}> {
  const paths = await clipboard?.getFilePaths?.();
  if (paths?.length) {
    if (paths.length > 8) throw new Error('At most eight clipboard files may be attached');
    return {attachments: await Promise.all(paths.map(path => readAttachment({path,cwd:process.cwd()})))};
  }
  let image = await clipboard?.getImage();
  if (image === undefined && process.platform === 'linux') {
    // Query only the current display protocol: do not fall back to stale X11 contents
    // when Wayland explicitly reports an empty clipboard.
    const command = process.env.WAYLAND_DISPLAY ? 'wl-paste' : 'xclip';
    const args = process.env.WAYLAND_DISPLAY ? ['--type','image/png','--no-newline'] : ['-selection','clipboard','-t','image/png','-o'];
    try { image = (await promisify(execFile)(command,args,{encoding:'buffer',timeout:2000,maxBuffer:MAX_IMAGE_BYTES})).stdout; }
    catch { image = null; }
  }
  if (image?.length) {
    if (image.length > MAX_IMAGE_BYTES) throw new Error('Clipboard image exceeds 8 MiB');
    const bytes = Buffer.from(image);
    const mimeType = imageMimeType(bytes);
    if (!mimeType) throw new Error('Clipboard image format is unsupported; save it as PNG or JPEG and use /attach');
    return {attachments:[{path:'clipboard image',image:{type:'image',mimeType,data:bytes.toString('base64')}}]};
  }
  const text = await clipboard?.getText();
  if (typeof text === 'string') return {attachments:[],text};
  throw new Error('No supported clipboard image/files/text. Use /attach LOCAL_PATH.');
}

/** Uses the user's own local editor command; remote strings never become shell code. */
export async function editLocally(text: string, command = process.env.VISUAL ?? process.env.EDITOR ?? 'nano'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(),'pi-remote-editor-'));
  const path = join(directory,'prompt.txt');
  try {
    await writeFile(path,text,{mode:0o600});
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(`${command} ${shellQuote(path)}`,{shell:true,stdio:'inherit'});
      child.once('error',reject);
      child.once('exit',code=>code===0?resolve():reject(new Error(`External editor exited ${code}; original draft retained`)));
    });
    return await readFile(path,'utf8');
  } finally {await rm(directory,{recursive:true,force:true});}
}
