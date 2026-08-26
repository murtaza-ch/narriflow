export interface RenderDiagnostic {
  level: "info" | "error";
  message: string;
  context?: Record<string, unknown>;
}

interface ProductionRenderDiagnosticDependencies {
  now: () => Date;
  write: (line: string) => void;
}

export class ProductionRenderDiagnosticAdapter {
  readonly #dependencies: ProductionRenderDiagnosticDependencies;

  constructor(
    dependencies: ProductionRenderDiagnosticDependencies = {
      now: () => new Date(),
      write: (line) => console.warn(line),
    },
  ) {
    this.#dependencies = dependencies;
  }

  readonly diagnose = (diagnostic: RenderDiagnostic): void => {
    this.#dependencies.write(
      JSON.stringify({
        ...diagnostic.context,
        level: diagnostic.level,
        message: diagnostic.message,
        ts: this.#dependencies.now().toISOString(),
      }),
    );
  };
}

export const productionRenderDiagnosticAdapter =
  new ProductionRenderDiagnosticAdapter();
