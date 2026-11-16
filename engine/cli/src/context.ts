import type { Command } from "commander";
import { loadProduct, resolveProductsDir, type LoadedProduct, type ProviderOverrides } from "@demoforge/products";
import { resolveOutputDir } from "@demoforge/core";
import type { AiProviderName, TtsProviderName } from "@demoforge/contracts";

export interface GlobalOptions {
  productsDir?: string;
  outputDir?: string;
  logLevel?: string;
}

export function globals(cmd: Command): { productsDir: string; outputDir: string; logLevel?: string } {
  const opts = cmd.optsWithGlobals<GlobalOptions>();
  return { productsDir: resolveProductsDir(opts.productsDir), outputDir: resolveOutputDir(opts.outputDir), logLevel: opts.logLevel };
}

export interface ProviderFlags {
  aiProvider?: string;
  aiModel?: string;
  ttsProvider?: string;
}

export function providerOverrides(flags: ProviderFlags): ProviderOverrides {
  return {
    aiProvider: flags.aiProvider as AiProviderName | undefined,
    aiModel: flags.aiModel,
    ttsProvider: flags.ttsProvider as TtsProviderName | undefined,
  };
}

export async function openProduct(cmd: Command, id: string, flags: ProviderFlags = {}): Promise<LoadedProduct> {
  return loadProduct(globals(cmd).productsDir, id, providerOverrides(flags));
}
