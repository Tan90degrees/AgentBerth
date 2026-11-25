import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import { ACP_IMAGE_LIMIT, type AcpAttachment, type acpImageChunkSchema } from '../shared/acp-workbench';
import { projectFilePath } from './files';

type ImageChunk = z.infer<typeof acpImageChunkSchema>;
type Image = { mimeType: string; bytes: number; chunks: Buffer[]; completed: boolean };
type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name: string }
  | { type: 'image'; mimeType: string; data: string };

export class AcpAttachments {
  private readonly images = new Map<string, Image>();

  add({ imageId, mimeType, offset, data, last }: ImageChunk) {
    const buffer = Buffer.from(data, 'base64');
    let image = this.images.get(imageId);
    if (offset === 0 && (image || this.images.size < 8)) {
      image = { mimeType, bytes: 0, chunks: [], completed: false };
      this.images.set(imageId, image);
    }
    if (!image || image.mimeType !== mimeType || image.bytes !== offset || image.completed) throw new Error('ACP 图片上传已中断，请重新添加');
    if (image.bytes + buffer.length > ACP_IMAGE_LIMIT) {
      this.images.delete(imageId);
      throw new Error('单张图片最多 2 MiB');
    }
    image.chunks.push(buffer);
    image.bytes += buffer.length;
    if (last) {
      const bytes = Buffer.concat(image.chunks);
      const actual = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp'
        : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) ? 'image/gif' : '';
      if (actual !== mimeType) {
        this.images.delete(imageId);
        throw new Error('图片内容与文件格式不匹配');
      }
      image.completed = true;
    }
    return { offset: image.bytes };
  }

  async prompt(cwd: string, text: string, attachments: AcpAttachment[]) {
    const prompt: PromptBlock[] = text ? [{ type: 'text', text }] : [];
    let imageBytes = 0;
    for (const attachment of attachments) {
      if (attachment.type === 'image') {
        const image = this.images.get(attachment.id);
        if (!image?.completed) throw new Error('图片已失效，请重新添加');
        imageBytes += image.bytes;
        if (imageBytes > 4 * 1024 * 1024) throw new Error('单条消息的图片合计最多 4 MiB');
        prompt.push({ type: 'image', mimeType: image.mimeType, data: Buffer.concat(image.chunks).toString('base64') });
      } else {
        const file = await projectFilePath(cwd, attachment.path);
        if (!(await stat(file.absolute)).isFile()) throw new Error('请选择当前工作区中的文件');
        prompt.push({ type: 'resource_link', uri: pathToFileURL(file.absolute).href, name: file.relative });
        if (attachment.text) prompt.push({ type: 'text', text: file.relative + '\n' + attachment.text });
      }
    }
    return prompt;
  }

  remove(attachments: AcpAttachment[] = []) {
    for (const attachment of attachments) if (attachment.type === 'image') this.images.delete(attachment.id);
  }
}
