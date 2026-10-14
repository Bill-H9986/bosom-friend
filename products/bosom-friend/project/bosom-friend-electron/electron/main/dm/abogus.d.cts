declare const abogus: {
  generateABogus(params: string, userAgent: string): string;
  sm3(bytes: Uint8Array | Buffer): Uint8Array;
};
export = abogus;
