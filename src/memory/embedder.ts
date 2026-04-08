/**
 * Embedding service using all-MiniLM-L6-v2 via @huggingface/transformers.
 * Produces 384-dimensional vectors for semantic search.
 */
export class Embedder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractor: any = null;

  async initialize(): Promise<void> {
    const { pipeline } = await import("@huggingface/transformers");
    this.extractor = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    );
  }

  async embed(text: string): Promise<number[]> {
    if (!this.extractor) {
      await this.initialize();
    }
    const output = await this.extractor(text, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data as Float32Array).slice(0, 384);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
