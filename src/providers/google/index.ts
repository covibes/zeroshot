interface ProviderConstructor {
  new (): { readonly name: string };
}

interface ProvidersFacade {
  createProviderClass(name: string): ProviderConstructor;
}

// The generated CommonJS entrypoint resolves the maintained provider facade one directory up.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { createProviderClass }: ProvidersFacade = require('..');

export = createProviderClass('gemini');
