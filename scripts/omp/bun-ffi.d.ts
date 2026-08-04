declare module 'bun:ffi' {
  type FfiArgument = number | bigint | ArrayBufferView;
  type FfiReturn<Definition> = Definition extends { readonly returns: 'ptr' }
    ? number
    : Definition extends { readonly returns: 'i64' }
      ? bigint
      : number;
  type FfiSymbols<Definitions extends Readonly<Record<string, unknown>>> = {
    readonly [Name in keyof Definitions]: (
      ...arguments_: FfiArgument[]
    ) => FfiReturn<Definitions[Name]>;
  };

  export function dlopen<Definitions extends Readonly<Record<string, unknown>>>(
    library: string,
    definitions: Definitions
  ): {
    readonly symbols: FfiSymbols<Definitions>;
    close(): void;
  };

  export function ptr(value: ArrayBufferView): number;
  export function toArrayBuffer(
    pointer: number,
    byteOffset?: number,
    byteLength?: number
  ): ArrayBuffer;
}
