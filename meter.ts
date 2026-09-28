// Keep complete semantic blocks: tokenizing each transport chunk separately is
// incorrect because a later chunk can merge with the preceding token(s).
export class OutputBlocks {
  blocks = new Map();
  revision = 0;

  update(event) {
    const index = event.contentIndex;
    if (index === undefined) return false;
    const content = event.partial?.content?.[index];
    const block = this.blocks.get(index) ?? { type: content?.type, text: '', name: '', rawArguments: false };
    const oldText = block.text, oldName = block.name, oldType = block.type;
    if (event.type.startsWith('text_')) {
      block.type = 'text';
      // Pi's partial is mutable and may already contain later queued deltas.
      if (event.type === 'text_delta') block.text += event.delta;
      if (event.type === 'text_end') block.text = event.content;
    } else if (event.type.startsWith('thinking_')) {
      block.type = 'thinking';
      // Encrypted/redacted thinking signatures are not generated visible text.
      if (event.type === 'thinking_delta') block.text += event.delta;
      if (event.type === 'thinking_end') block.text = event.content;
    } else if (event.type.startsWith('toolcall_')) {
      block.type = 'toolCall';
      block.name = event.toolCall?.name ?? content?.name ?? block.name;
      if (event.type === 'toolcall_delta') {
        block.text += event.delta;
        block.rawArguments = true;
      } else if (!block.rawArguments && event.type === 'toolcall_end') {
        block.text = JSON.stringify(event.toolCall.arguments ?? {});
      }
    } else return false;
    this.blocks.set(index, block);
    if (oldText !== block.text || oldName !== block.name || oldType !== block.type) {
      this.revision++;
      return true;
    }
    return false;
  }

  finish(content) {
    for (const [index, value] of content.entries()) {
      const block = this.blocks.get(index);
      if (value.type === 'text' || value.type === 'thinking') {
        this.blocks.set(index, { type: value.type, text: value.text ?? value.thinking ?? '', name: '' });
      } else if (value.type === 'toolCall') {
        this.blocks.set(index, { type: value.type, name: value.name,
          text: block?.rawArguments ? block.text : JSON.stringify(value.arguments ?? {}), rawArguments: block?.rawArguments });
      }
    }
    this.revision++;
  }

  snapshot() {
    return [...this.blocks.entries()].sort(([a], [b]) => a - b)
      .flatMap(([, block]) => block.type === 'toolCall' ? [block.name, block.text] : [block.text]);
  }
}

export class Throughput {
  first;
  latest;
  history = [];
  constructor(windowMs = 3000) { this.windowMs = windowMs; }

  add(time, count) {
    if (this.latest && time < this.latest.time) return;
    const point = { time, count };
    if (!this.first) this.first = point;
    if (this.latest?.time === time) this.history.pop();
    this.latest = point;
    this.history.push(point);
    this.prune(time);
  }

  prune(now) {
    const cutoff = now - this.windowMs;
    while (this.history.length > 1 && this.history[1].time <= cutoff) this.history.shift();
  }

  rates(now) {
    if (!this.first || !this.latest) return { rolling: undefined, average: undefined };
    this.prune(now);
    const elapsed = now - this.first.time;
    // The first received batch has unknown generation duration. Exclude all of
    // it from rate numerators, not just one token. Still include it in totals.
    const average = elapsed >= 100 && this.latest.time > this.first.time
      ? Math.max(0, this.latest.count - this.first.count) * 1000 / elapsed : undefined;
    const start = Math.max(this.first.time, now - this.windowMs);
    const baseline = this.history[0];
    const rolling = now - start >= 100 && this.latest.time > this.first.time
      ? Math.max(0, this.latest.count - baseline.count) * 1000 / (now - start) : undefined;
    return { rolling, average };
  }
}
