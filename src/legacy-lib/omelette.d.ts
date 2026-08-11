declare module 'omelette' {
  interface CompletionData {
    line: string;
    reply(candidates: string[]): void;
  }

  interface Completion {
    init(): void;
    on(event: 'complete', listener: (fragment: string, data: CompletionData) => void): this;
  }

  function omelette(template: string): Completion;

  export = omelette;
}
