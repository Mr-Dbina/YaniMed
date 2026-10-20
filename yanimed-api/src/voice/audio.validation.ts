import { BadRequestException } from '@nestjs/common';

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export interface AudioUpload {
  buffer: Buffer;
  mimetype: string;
  size: number;
}
export const AUDIO_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/flac',
];

export function validateAudio(file?: AudioUpload): {
  type: string;
  extension: string;
} {
  if (
    !file?.buffer?.length ||
    file.size > MAX_AUDIO_BYTES ||
    file.buffer.length > MAX_AUDIO_BYTES
  )
    throw new BadRequestException(
      'Provide a non-empty audio file no larger than 10 MiB.',
    );
  const b = file.buffer;
  const type = file.mimetype;
  let valid = false;
  let extension = '';
  if (['audio/mpeg', 'audio/mp3'].includes(type)) {
    valid =
      b.length > 3 &&
      (b.subarray(0, 3).toString() === 'ID3' ||
        (b[0] === 255 && (b[1] & 224) === 224));
    extension = 'mp3';
  }
  if (['audio/wav', 'audio/x-wav', 'audio/wave'].includes(type)) {
    valid =
      b.length > 44 &&
      b.subarray(0, 4).toString() === 'RIFF' &&
      b.subarray(8, 12).toString() === 'WAVE';
    extension = 'wav';
  }
  if (type === 'audio/webm') {
    valid =
      b.length > 4 && b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    extension = 'webm';
  }
  if (type === 'audio/ogg') {
    valid = b.length > 4 && b.subarray(0, 4).toString() === 'OggS';
    extension = 'ogg';
  }
  if (['audio/mp4', 'audio/x-m4a'].includes(type)) {
    valid = b.length > 12 && b.subarray(4, 8).toString() === 'ftyp';
    extension = 'm4a';
  }
  if (type === 'audio/flac') {
    valid = b.length > 4 && b.subarray(0, 4).toString() === 'fLaC';
    extension = 'flac';
  }
  if (!valid)
    throw new BadRequestException(
      'Unsupported audio type or invalid audio header.',
    );
  return { type, extension };
}
