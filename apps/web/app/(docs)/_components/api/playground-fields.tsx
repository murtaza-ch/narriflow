"use client";

import { type ReactNode, useState } from "react";
import { Box, Flex, NativeSelect, Text } from "@chakra-ui/react";
import { ChevronsDownUp, Plus, X } from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import type { ParameterObject, SchemaObject } from "@/lib/docs/openapi";
import { getIn, type Path } from "./body-state";
import { Chip } from "./chip";
import { primaryType } from "./sample";
import { childrenOf, flatten, isObjectSchema, typeLabel } from "./schema";

export interface FormContext {
  tree: unknown;
  set: (path: Path, value: unknown) => void;
  /** The "Show optional fields" switch at the top of the form. */
  expandAll: boolean;
}

/** Authorization, Headers, Path, Query, Body: one soft card each. */
export function InputSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Box as="section" aria-label={title} bg="bg.subtle" borderRadius="12px" p="4">
      <Flex align="center" justify="space-between" gap="3" minH="8" mb="3">
        <Text fontSize="14px" fontWeight="500">
          {title}
        </Text>
        {aside}
      </Flex>
      <Flex direction="column" gap="5">
        {children}
      </Flex>
    </Box>
  );
}

function Label({ prefix, name, pills, required }: { prefix?: string; name: string; pills: string[]; required?: boolean }) {
  return (
    <Flex align="center" wrap="wrap" columnGap="2" rowGap="1">
      <Text as="span" fontFamily="mono" fontSize="13px" fontWeight="500" overflowWrap="anywhere">
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
      {required ? (
        <Text as="span" fontSize="12px" fontWeight="500" color="danger.fg">
          required
        </Text>
      ) : null}
    </Flex>
  );
}

/** One field: its name and notes, then the input beneath. */
function InputRow({
  prefix,
  name,
  pills,
  required,
  description,
  onDelete,
  children,
}: {
  prefix?: string;
  name: string;
  pills: string[];
  required?: boolean;
  description?: string;
  onDelete?: () => void;
  children: ReactNode;
}) {
  return (
    <Flex align="flex-start" gap="2">
      <Box flex="1" minW="0">
        <Label prefix={prefix} name={name} pills={pills} required={required} />
        {description ? (
          <Text mt="1" fontSize="13px" color="fg.muted" whiteSpace="pre-line">
            {description}
          </Text>
        ) : null}
        <Box mt="2">{children}</Box>
      </Box>
      {onDelete ? <RemoveButton onClick={onDelete} /> : null}
    </Flex>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton type="button" variant="ghost" size="xs" aria-label="Remove item" onClick={onClick}>
      <X size={14} />
    </IconButton>
  );
}

export interface ValueInputProps {
  schema: SchemaObject;
  name: string;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Keeps empty strings, for list items that must stay in place. */
  keepEmpty?: boolean;
}

export function ValueInput({ schema, name, value, onChange, keepEmpty }: ValueInputProps) {
  const flat = flatten(schema);
  const type = primaryType(flat);
  const options = flat.enum ?? (type === "boolean" ? [true, false] : undefined);
  const empty = keepEmpty ? "" : undefined;

  if (options) {
    return (
      <NativeSelect.Root size="sm">
        <NativeSelect.Field
          aria-label={`Select ${name}`}
          value={value === undefined ? "" : String(value)}
          onChange={(event) => {
            const picked = event.target.value;
            onChange(picked === "" ? empty : (options.find((option) => String(option) === picked) ?? picked));
          }}
        >
          <option value="">Select {name}</option>
          {options.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </NativeSelect.Field>
        <NativeSelect.Indicator />
      </NativeSelect.Root>
    );
  }

  const numeric = type === "integer" || type === "number";
  return (
    <Input
      aria-label={`Enter ${name}`}
      type={numeric ? "number" : "text"}
      step={type === "integer" ? 1 : undefined}
      placeholder={`Enter ${name}`}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(event) => {
        const raw = event.target.value;
        if (raw === "") onChange(empty);
        else onChange(numeric ? Number(raw) : raw);
      }}
    />
  );
}

export function ParameterInput({ parameter, value, onChange }: { parameter: ParameterObject; value: string; onChange: (value: string) => void }) {
  const schema = parameter.schema ?? { type: "string" };
  return (
    <InputRow name={parameter.name} pills={[typeLabel(schema)]} required={parameter.required} description={parameter.description ?? schema.description}>
      <ValueInput schema={schema} name={parameter.name} value={value} onChange={(next) => onChange(next === undefined ? "" : String(next))} />
    </InputRow>
  );
}

/** The API key field. It is masked on screen and never leaves this tab's session storage. */
export function CredentialInput({ name, prefix, description, value, onChange, inputRef }: {
  name: string;
  prefix?: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <InputRow name={name} pills={[prefix ? `string<${prefix.toLowerCase()}>` : "string"]} required description={description}>
      <Input
        ref={inputRef}
        type="password"
        aria-label="API key"
        placeholder="nf_…"
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore
        value={value}
        onChange={(event) => onChange(event.target.value.trim())}
      />
    </InputRow>
  );
}

// --- The request body form.

interface FieldProps {
  name: string;
  schema: SchemaObject;
  required: boolean;
  path: Path;
  /** Dotted parent names. */
  prefix: string;
  context: FormContext;
  onDelete?: () => void;
}

function Field({ name, schema, required, path, prefix, context, onDelete }: FieldProps) {
  const flat = flatten(schema);
  const type = primaryType(flat);

  if (type === "array") return <ListField {...{ name, schema: flat, required, path, prefix, context }} />;
  if (isObjectSchema(flat)) return <GroupField {...{ name, schema: flat, required, path, prefix, context, onDelete }} />;
  if (type === "object") return null;

  return (
    <InputRow prefix={prefix} name={name} pills={[typeLabel(schema)]} required={required} description={flat.description} onDelete={onDelete}>
      <ValueInput schema={flat} name={name} value={getIn(context.tree, path)} onChange={(value) => context.set(path, value)} />
    </InputRow>
  );
}

/** The fields of an object: required ones first, optional ones behind a toggle. */
export function ObjectFields({ schema, path, prefix, context }: { schema: SchemaObject; path: Path; prefix: string; context: FormContext }) {
  const [expanded, setExpanded] = useState(false);
  const rows = childrenOf(schema).rows;
  const required = rows.filter((row) => row.required);
  const optional = rows.filter((row) => !row.required);
  const showOptional = context.expandAll || expanded;
  const render = (row: (typeof rows)[number]) => (
    <Field key={row.name} name={row.name} schema={row.schema} required={row.required} path={[...path, row.name]} prefix={prefix} context={context} />
  );
  return (
    <Flex direction="column" gap="5">
      {required.map(render)}
      {showOptional ? optional.map(render) : null}
      {optional.length && !context.expandAll ? (
        <Button type="button" variant="subtle" size="xs" alignSelf="flex-start" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronsDownUp size={14} /> : <Plus size={14} />}
          {expanded ? "Hide" : "Show"} {optional.length} optional field{optional.length === 1 ? "" : "s"}
        </Button>
      ) : null}
    </Flex>
  );
}

/** An object inside the form: its own fields on a soft panel. */
function GroupField({ name, schema, required, path, prefix, context, onDelete }: FieldProps) {
  return (
    <Flex align="flex-start" gap="2">
      <Box flex="1" minW="0" p="3" bg="bg.soft" borderRadius="10px">
        <Label prefix={prefix} name={name} pills={[typeLabel(schema)]} required={required} />
        {schema.description ? (
          <Text mt="1" fontSize="13px" color="fg.muted" whiteSpace="pre-line">
            {schema.description}
          </Text>
        ) : null}
        <Box mt="3">
          <ObjectFields schema={schema} path={path} prefix={`${prefix}${name}.`} context={context} />
        </Box>
      </Box>
      {onDelete ? <RemoveButton onClick={onDelete} /> : null}
    </Flex>
  );
}

/** An array: its items, each removable, and an "Add item" button. */
function ListField({ name, schema, required, path, prefix, context }: FieldProps) {
  const items = getIn(context.tree, path);
  const list = Array.isArray(items) ? items : [];
  const itemSchema = schema.items ? flatten(schema.items) : { type: "string" };
  const objectItems = isObjectSchema(itemSchema);
  return (
    <Box>
      <Label prefix={prefix} name={name} pills={[typeLabel(schema)]} required={required} />
      {schema.description ? (
        <Text mt="1" fontSize="13px" color="fg.muted" whiteSpace="pre-line">
          {schema.description}
        </Text>
      ) : null}
      <Flex direction="column" gap="3" mt={list.length ? "3" : "0"}>
        {list.map((_, index) => {
          const itemPath = [...path, index];
          const remove = () => context.set(itemPath, undefined);
          return objectItems ? (
            <GroupField key={index} name={`${name}[${index}]`} schema={itemSchema} required={false} path={itemPath} prefix="" context={context} onDelete={remove} />
          ) : (
            <InputRow key={index} name={`${name}[${index}]`} pills={[typeLabel(itemSchema)]} onDelete={remove}>
              <ValueInput schema={itemSchema} name={`${name}[${index}]`} value={list[index]} keepEmpty onChange={(value) => context.set(itemPath, value)} />
            </InputRow>
          );
        })}
      </Flex>
      <Button type="button" variant="subtle" size="xs" mt="3" onClick={() => context.set([...path, list.length], objectItems ? {} : "")}>
        <Plus size={14} />
        Add item
      </Button>
    </Box>
  );
}
