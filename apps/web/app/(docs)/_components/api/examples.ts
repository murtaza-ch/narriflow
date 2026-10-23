import type { ReactNode } from "react";

/** A request example in one language; `node` is its highlighted form. */
export interface ExampleLanguage {
  id: string;
  label: string;
  text: string;
  node: ReactNode;
}

/** A response example for one status code. */
export interface ExampleResponse {
  code: string;
  text: string;
  node: ReactNode;
}
