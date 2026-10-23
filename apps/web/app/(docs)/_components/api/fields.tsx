import type { ReactNode } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { Expandable } from "./expandable";
import { Chip, InlineCode } from "./chip";
import { FieldList } from "./field-list";
import { Options } from "./options";
import type { Constraint } from "./schema";

export { Expandable, type ExpandableProps } from "./expandable";
export { FieldList } from "./field-list";

/** Plain text with `code` spans; descriptions come from the OpenAPI document. */
export function Inline({ text }: { text: string }) {
  return text.split(/(`[^`]+`)/).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <InlineCode key={index}>{part.slice(1, -1)}</InlineCode> : part,
  );
}

/** A description paragraph from the spec. */
export function Paragraph({ text }: { text: string }) {
  return (
    <Text as="p" whiteSpace="pre-line">
      <Inline text={text} />
    </Text>
  );
}

function ConstraintLine({ constraint }: { constraint: Constraint }) {
  return (
    <Text mt="2" fontSize="12.5px" color="fg.subtle">
      {constraint.label}: <InlineCode>{constraint.value}</InlineCode>
      {constraint.suffix ? ` ${constraint.suffix}` : null}
    </Text>
  );
}

export interface FieldRowProps {
  id?: string;
  /** Parent path, shown dimmed in front of the name. */
  prefix?: string;
  name: string;
  /** Type chips: the type itself, then facts such as "header". */
  pills?: string[];
  defaultValue?: string;
  required?: boolean;
  deprecated?: boolean;
  description?: ReactNode;
  constraints?: Constraint[];
  options?: unknown[];
  /** Child rows, folded behind "Show child attributes". */
  nested?: ReactNode;
  /** Shown in place of the fold, such as option tabs. */
  extra?: ReactNode;
  children?: ReactNode;
}

/** One field of a request or response: name and flags, then what it means. */
export function FieldRow({
  id,
  prefix,
  name,
  pills = [],
  defaultValue,
  required,
  deprecated,
  description,
  constraints = [],
  options,
  nested,
  extra,
  children,
}: FieldRowProps) {
  const hasDescription = description !== undefined && description !== null && description !== "";
  return (
    <Box id={id} px="4" py="3.5" css={{ scrollMarginTop: "24px" }}>
      <Flex align="center" wrap="wrap" columnGap="2" rowGap="1">
        <Text as="span" fontFamily="mono" fontSize="13.5px" fontWeight="500" color="fg" overflowWrap="anywhere">
          {prefix ? (
            <Text as="span" color="fg.subtle" fontWeight="400">
              {prefix}
            </Text>
          ) : null}
          {name}
        </Text>
        {pills.map((pill) => (
          <Chip key={pill}>{pill}</Chip>
        ))}
        {defaultValue !== undefined ? <Chip>default: {defaultValue}</Chip> : null}
        {deprecated ? (
          <Chip bg="warning.subtle" color="warning.fg" fontFamily="body">
            deprecated
          </Chip>
        ) : null}
        {required ? (
          <Text as="span" fontSize="12px" fontWeight="500" color="danger.fg">
            required
          </Text>
        ) : null}
      </Flex>
      {hasDescription ? (
        <Box mt="1.5" fontSize="14px" lineHeight="1.6" color="fg.muted" css={{ "& p": { m: "0" }, "& > * + *": { mt: "2" } }}>
          {description}
        </Box>
      ) : null}
      {constraints.map((constraint) => (
        <ConstraintLine key={constraint.label} constraint={constraint} />
      ))}
      {options?.length ? <Options values={options} /> : null}
      {extra}
      {nested ? <Expandable>{nested}</Expandable> : null}
      {children}
    </Box>
  );
}

export interface ParamFieldProps {
  query?: string;
  path?: string;
  body?: string;
  header?: string;
  type?: string;
  required?: boolean;
  default?: string;
  deprecated?: boolean;
  children?: ReactNode;
}

/** `<ParamField>` in MDX: the same row the API reference prints. */
export function ParamField({ children, type, required, default: defaultValue, deprecated, ...location }: ParamFieldProps) {
  const [kind, name = ""] = Object.entries(location).find(([, value]) => typeof value === "string") ?? [];
  return (
    <FieldList my="2">
      <FieldRow
        id={kind ? `${kind === "header" ? "header" : "parameter"}-${name}` : undefined}
        name={name}
        pills={type ? [type] : []}
        defaultValue={defaultValue}
        required={required}
        deprecated={deprecated}
        description={children}
      />
    </FieldList>
  );
}

export interface ResponseFieldProps {
  name: string;
  type?: string;
  required?: boolean;
  default?: string;
  deprecated?: boolean;
  children?: ReactNode;
}

/** `<ResponseField>` in MDX. */
export function ResponseField({ name, type, required, default: defaultValue, deprecated, children }: ResponseFieldProps) {
  return (
    <FieldList my="2">
      <FieldRow
        id={`response-${name}`}
        name={name}
        pills={type ? [type] : []}
        defaultValue={defaultValue}
        required={required}
        deprecated={deprecated}
        description={children}
      />
    </FieldList>
  );
}
