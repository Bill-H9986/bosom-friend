/**
 * Bosom Friend Harness 渲染进程桥类型声明
 */
export interface ZhiyinHarnessBridge {
  invoke(action: string, input?: unknown): Promise<unknown>;
  runWorkflow(
    domain: 'content' | 'platform' | 'automation',
    input: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  chat(sessionId: string, message: string): void;
  submitInteraction(item: {
    kind: 'comment' | 'dm';
    platform: string;
    accountId: number;
    content: string;
    sourceId: string;
    workId?: string;
    commentId?: string;
    title?: string;
    peerName?: string;
  }): Promise<unknown>;
  automationStatus(): Promise<unknown>;
  onEvent(listener: (event: any) => void): () => void;
}

declare global {
  interface Window {
    zhiyinHarness?: ZhiyinHarnessBridge;
  }
}

export {};
