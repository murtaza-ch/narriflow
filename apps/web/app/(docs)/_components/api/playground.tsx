"use client";

import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from "react";
import { Box, Flex, Grid, Text } from "@chakra-ui/react";
import { Play } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { CloseButton, Dialog, Portal } from "@narriflow/ui/components/dialog";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Spinner } from "@narriflow/ui/components/spinner";
import { Textarea } from "@narriflow/ui/components/textarea";
import { MethodBadge } from "../method-badge";
import { maskToken, useApiState } from "./api-state";
import { overlay, type Path, setIn } from "./body-state";
import { LiveCode } from "./live-code";
import { PathSegments } from "./path-bar";
import { CredentialInput, type FormContext, InputSection, ObjectFields, ParameterInput } from "./playground-fields";
import { type PlaygroundResult, ResultCard } from "./playground-result";
import { RequestCard, ResponseCard } from "./request-panel";
import { sampleValue } from "./sample";
import { flatten, isObjectSchema } from "./schema";
import { buildRequest, generateSnippet, LANGUAGES } from "./snippets";
import type { ExampleLanguage } from "./examples";

export interface PlaygroundProps {
  bodyRequired?: boolean;
}

// Cards keep their own height here and the column scrolls, so the live request never gets squeezed.
const PANE_MAX_H = "22rem";

function useStrings() {
  const [values, setValues] = useState<Record<string, string>>({});
  const set = useCallback((name: string, value: string) => setValues((current) => ({ ...current, [name]: value })), []);
  return [values, set] as const;
}

/**
 * The "Try it" dialog: inputs on the left, the live request and the response
 * on the right. It is mounted from the first open on, so what was typed
 * survives closing. Requests go to the app itself, from the visitor's browser.
 */
export function Playground({ bodyRequired }: PlaygroundProps) {
  const { spec, title, token, setToken, playgroundOpen, setPlaygroundOpen, language, opener } = useApiState();
  const tokenInput = useRef<HTMLInputElement>(null);

  const [headers, setHeader] = useStrings();
  const [pathValues, setPathValue] = useStrings();
  const [query, setQuery] = useStrings();
  const [tree, setTree] = useState<unknown>(undefined);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<PlaygroundResult | undefined>();

  const sample = useMemo(() => (spec.bodySchema ? sampleValue(spec.bodySchema) : undefined), [spec.bodySchema]);

  const parsedJson = useMemo(() => {
    if (mode !== "json") return { value: undefined, error: undefined };
    try {
      return { value: jsonText.trim() ? (JSON.parse(jsonText) as unknown) : undefined, error: undefined };
    } catch (error) {
      return { value: undefined, error: (error as Error).message };
    }
  }, [mode, jsonText]);

  const entered = mode === "json" ? parsedJson.value : tree;
  const missingPath = spec.pathParams.filter((parameter) => !pathValues[parameter.name]?.trim());
  const canSend = !sending && missingPath.length === 0;

  const send = useCallback(async () => {
    if (!canSend) return;
    if (mode === "json" && parsedJson.error) {
      setResult({ kind: "error", message: `The request body is not valid JSON: ${parsedJson.error}` });
      return;
    }
    // The visitor's browser calls this app directly, so the request needs no relay and the key goes nowhere else.
    const request = buildRequest({ ...spec, origin: window.location.origin }, { token, headers, path: pathValues, query, body: entered }, true);
    if (spec.bodySchema && request.body === undefined && bodyRequired) request.body = {};
    if (request.body !== undefined && spec.contentType && !request.headers.some(([name]) => name === "Content-Type")) {
      request.headers.push(["Content-Type", spec.contentType]);
    }
    setSending(true);
    const started = performance.now();
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        // Only the key authenticates, as it would from any other client.
        credentials: "omit",
      });
      const body = await response.text();
      setResult({
        kind: "response",
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        body,
        time: Math.round(performance.now() - started),
      });
    } catch (error) {
      setResult({ kind: "error", message: `The request could not be sent: ${(error as Error).message}` });
    } finally {
      setSending(false);
    }
  }, [canSend, mode, parsedJson.error, spec, token, headers, pathValues, query, entered, bodyRequired]);

  const context: FormContext = { tree, set: (path: Path, value) => setTree((current: unknown) => setIn(current, path, value)), expandAll };

  const switchMode = (next: string) => {
    if (next === mode || (next !== "form" && next !== "json")) return;
    if (next === "json") setJsonText(JSON.stringify(overlay(sample, tree), null, 2));
    else if (!parsedJson.error) setTree(parsedJson.value);
    setMode(next);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  // The snippet shows the same request with the key masked: it is for reading, never for leaking.
  const shown = { token: maskToken(token), headers, path: pathValues, query, body: mode === "json" ? (parsedJson.error ? sample : parsedJson.value) : overlay(sample, tree) };
  const snippets: ExampleLanguage[] = LANGUAGES.map((item) => {
    const text = generateSnippet(item.id, buildRequest(spec, shown));
    return { id: item.id, label: item.label, text, node: item.id === language ? <LiveCode code={text} lang={item.grammar} /> : null };
  });

  const bodySchema = spec.bodySchema ? flatten(spec.bodySchema) : undefined;
  const hasOptional = bodySchema ? Object.keys(bodySchema.properties ?? {}).length > (bodySchema.required?.length ?? 0) : false;

  return (
    <Dialog.Root
      open={playgroundOpen}
      onOpenChange={(details) => setPlaygroundOpen(details.open)}
      placement="center"
      lazyMount
      unmountOnExit
      initialFocusEl={() => (token ? null : tokenInput.current)}
      finalFocusEl={() => opener.current}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="1120px" w="full" onKeyDown={onKeyDown}>
            <Dialog.Header flexDirection="column" alignItems="stretch" gap="4">
              <Dialog.Title>{title}</Dialog.Title>
              <Flex align="center" gap="2" p="1.5" ps="3" bg="bg.subtle" borderRadius="12px">
                <MethodBadge method={spec.method} size="md" />
                <Box flex="1" minW="0">
                  <PathSegments path={spec.path} method={spec.method} />
                </Box>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void send()}
                  disabled={!canSend}
                  title="Send (Ctrl or ⌘ Enter)"
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                >
                  {sending ? <Spinner size="xs" /> : <Play size={12} fill="currentColor" />}
                  Send
                </Button>
              </Flex>
              {missingPath.length ? (
                <Text fontSize="12px" color="fg.subtle" mt="-2">
                  Enter {missingPath.map((parameter) => parameter.name).join(", ")} to send.
                </Text>
              ) : null}
            </Dialog.Header>
            <Dialog.Body>
              <Grid templateColumns={{ base: "minmax(0, 1fr)", lg: "minmax(0, 3fr) minmax(0, 2fr)" }} gap="6" alignItems="start">
                <Flex direction="column" gap="3" minW="0">
                  {spec.auth ? (
                    <InputSection title="Authorization">
                      <CredentialInput
                        inputRef={tokenInput}
                        name={spec.auth.name}
                        prefix={spec.auth.prefix}
                        description={spec.auth.description}
                        value={token}
                        onChange={setToken}
                      />
                    </InputSection>
                  ) : null}
                  {spec.headers.length ? (
                    <InputSection title="Headers">
                      {spec.headers.map((parameter) => (
                        <ParameterInput key={parameter.name} parameter={parameter} value={headers[parameter.name] ?? ""} onChange={(value) => setHeader(parameter.name, value)} />
                      ))}
                    </InputSection>
                  ) : null}
                  {spec.pathParams.length ? (
                    <InputSection title="Path parameters">
                      {spec.pathParams.map((parameter) => (
                        <ParameterInput key={parameter.name} parameter={parameter} value={pathValues[parameter.name] ?? ""} onChange={(value) => setPathValue(parameter.name, value)} />
                      ))}
                    </InputSection>
                  ) : null}
                  {spec.queryParams.length ? (
                    <InputSection title="Query parameters">
                      {spec.queryParams.map((parameter) => (
                        <ParameterInput key={parameter.name} parameter={parameter} value={query[parameter.name] ?? ""} onChange={(value) => setQuery(parameter.name, value)} />
                      ))}
                    </InputSection>
                  ) : null}
                  {bodySchema ? (
                    <InputSection
                      title="Body"
                      aside={
                        <Flex align="center" gap="2">
                          {hasOptional && mode === "form" ? (
                            <Button type="button" variant="ghost" size="xs" aria-pressed={expandAll} onClick={() => setExpandAll(!expandAll)}>
                              {expandAll ? "Hide optional fields" : "Show optional fields"}
                            </Button>
                          ) : null}
                          <SegmentedControl
                            aria-label="Request body format"
                            items={[
                              { label: "Form", value: "form" },
                              { label: "JSON", value: "json" },
                            ]}
                            value={mode}
                            onValueChange={switchMode}
                          />
                        </Flex>
                      }
                    >
                      {mode === "json" ? (
                        <Box>
                          <Textarea
                            aria-label="Request body JSON"
                            aria-invalid={parsedJson.error ? true : undefined}
                            spellCheck={false}
                            value={jsonText}
                            onChange={(event) => setJsonText(event.target.value)}
                            rows={14}
                            fontFamily="mono"
                            fontSize="12.5px"
                            lineHeight="1.7"
                          />
                          {parsedJson.error ? (
                            <Text mt="2" fontSize="12px" color="danger.fg">
                              {parsedJson.error}
                            </Text>
                          ) : null}
                        </Box>
                      ) : isObjectSchema(bodySchema) ? (
                        <ObjectFields schema={bodySchema} path={[]} prefix="" context={context} />
                      ) : null}
                    </InputSection>
                  ) : null}
                </Flex>

                <Flex
                  direction="column"
                  gap="3"
                  minW="0"
                  position={{ lg: "sticky" }}
                  top="0"
                  maxH={{ lg: "calc(100dvh - 232px)" }}
                  overflowY="auto"
                  css={{ "& > *": { flexShrink: 0 } }}
                >
                  {result ? <ResultCard result={result} /> : null}
                  <RequestCard languages={snippets} maxH={PANE_MAX_H} />
                  <ResponseCard maxH={PANE_MAX_H} />
                </Flex>
              </Grid>
            </Dialog.Body>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
