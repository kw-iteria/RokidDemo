// Replays a video file through ffmpeg as an MJPEG stream, in real time, as if it were a camera.
import { spawn, type ChildProcess } from 'node:child_process';

export interface ReplayOptions {
  file: string;
  fps: number;
  width: number;
  loop: boolean;
  onFrame: (jpeg: Buffer, index: number) => void;
  onEnd: () => void;
}

export function startReplay(opts: ReplayOptions): { stop: () => void; proc: ChildProcess } {
  const args = ['-v', 'error', '-re'];
  if (opts.loop) args.push('-stream_loop', '-1');
  args.push('-i', opts.file, '-vf', `fps=${opts.fps},scale=${opts.width}:-2`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1');
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0);
  let index = 0;
  proc.stdout.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    // Split on JPEG SOI/EOI markers.
    for (;;) {
      const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (soi < 0) { buf = Buffer.alloc(0); break; }
      const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
      if (eoi < 0) { if (soi > 0) buf = buf.subarray(soi); break; }
      const jpeg = Buffer.from(buf.subarray(soi, eoi + 2));
      buf = buf.subarray(eoi + 2);
      opts.onFrame(jpeg, index++);
    }
  });
  proc.on('close', () => opts.onEnd());
  return { stop: () => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, proc };
}
