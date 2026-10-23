import type { MDXComponents } from "mdx/types";
import { Expandable, ParamField, ResponseField } from "@/app/(docs)/_components/api/fields";
import { Accordion, AccordionGroup } from "./accordion";
import { Badge } from "./badge";
import { Callout, Check, Danger, Info, Note, Tip, Warning } from "./callout";
import { Card, CardGroup } from "./card";
import { CodeBlock, CodeGroup, RequestExample, ResponseExample } from "./code";
import { Frame } from "./frame";
import { H2, H3, H4 } from "./heading";
import { InlineIcon } from "./icon";
import { A } from "./link";
import { Panel } from "./panel";
import { Step, Steps } from "./steps";
import { Table } from "./table";
import { Tab, Tabs } from "./tabs";
import { Tile } from "./tile";
import { Tooltip } from "./tooltip";
import { Tree } from "./tree";
import { Update } from "./update";
import { ZoomImage } from "./zoom-image";

/** Everything an MDX page can use. The page frame wraps the output in `DocsProse` for typography. */
export const mdxComponents: MDXComponents = {
  a: A,
  h2: H2,
  h3: H3,
  h4: H4,
  img: ZoomImage,
  pre: CodeBlock,
  table: Table,
  Accordion,
  AccordionGroup,
  Badge,
  Callout,
  Card,
  CardGroup,
  Check,
  CodeGroup,
  Columns: CardGroup,
  Danger,
  Expandable,
  Frame,
  Icon: InlineIcon,
  Info,
  Note,
  Panel,
  ParamField,
  RequestExample,
  ResponseExample,
  ResponseField,
  Step,
  Steps,
  Tab,
  Tabs,
  Tile,
  Tip,
  Tooltip,
  Tree,
  Update,
  Warning,
};
