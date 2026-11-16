import type { Command } from "commander";
import { loadProduct, type LoadedProduct, type ProviderOverrides } from "@demoforge/products";
import { OUTPUT_DIR, PRODUCTS_DIR } from "@demoforge/shared";
import type { AiProviderName, TtsProviderName } from "@demoforge/contracts";

export interface GlobalOptions {
  logLevel?: string;
}

/** Products always live in <repo>/products and jobs in <repo>/output. */
export function globals(cmd: Command): { productsDir: string; outputDir: string; logLevel?: string } {
  const opts = cmd.optsWithGlobals<GlobalOptions>();
  return { productsDir: PRODUCTS_DIR, outputDir: OUTPUT_DIR, logLevel: opts.logLevel };
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
