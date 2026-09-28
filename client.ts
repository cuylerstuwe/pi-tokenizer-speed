import { Worker } from 'node:worker_threads';

export class TokenizerClient {
  worker;
  pending = new Map();
  sequence = 0;
  closed = false;

  request(spec, blocks) {
    if (this.closed) return Promise.reject(new Error('Tokenizer stopped'));
    if (!this.worker) {
      const worker = new Worker(new URL('./tokenizer-worker.mjs', import.meta.url));
      this.worker = worker;
      worker.on('message', (result) => {
        const task = this.pending.get(result.id);
        if (!task) return;
        this.pending.delete(result.id);
        clearTimeout(task.timer);
        result.error ? task.reject(new Error(result.error)) : task.resolve(result.count);
      });
      const fail = (error) => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        for (const task of this.pending.values()) {
          clearTimeout(task.timer);
          task.reject(error);
        }
        this.pending.clear();
        void worker.terminate();
      };
      worker.on('error', fail);
      worker.on('exit', (code) => fail(new Error(`Tokenizer worker exited (${code})`)));
      worker.unref();
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Tokenizer timed out'));
        this.close();
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, spec, blocks });
    });
  }

  warm(spec) { return this.request(spec); }
  count(spec, blocks) { return this.request(spec, blocks); }

  close() {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error('Tokenizer stopped'));
    }
    this.pending.clear();
    if (worker) void worker.terminate();
  }
}
