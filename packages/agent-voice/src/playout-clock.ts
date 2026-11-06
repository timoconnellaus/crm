// When the browser's audio plays. Each chunk is scheduled right after the one before it, or now if
// playback has run dry, which is how `VoiceClient` queues audio; so what has played by any moment
// follows from when the chunks arrived and how long they are. Pure, so it is tested without audio.

export class PlayoutClock {
  #spans: { start: number; end: number }[] = [];
  #cursor = 0;

  /** A chunk of `ms` milliseconds arrived at `now`. */
  add(now: number, ms: number) {
    const start = Math.max(now, this.#cursor);
    this.#cursor = start + ms;
    this.#spans.push({ start, end: this.#cursor });
  }

  /** Milliseconds of audio played by `now`. */
  played(now: number): number {
    let total = 0;
    for (const { start, end } of this.#spans) {
      if (now <= start) break;
      total += Math.min(now, end) - start;
    }
    return total;
  }

  /** When the last chunk received so far finishes. */
  get endsAt(): number {
    return this.#cursor;
  }

  isPlaying(now: number): boolean {
    return now < this.#cursor;
  }

  reset() {
    this.#spans = [];
    this.#cursor = 0;
  }
}
