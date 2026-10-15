/** Result passed from the isolated presentation builder to the web server. */
export interface PresentationBundle {
  bundle: string;
  dependencies: string[];
  /** Fingerprint of the source bytes actually consumed by tracing and bundling. */
  sourceSignature: string;
}
