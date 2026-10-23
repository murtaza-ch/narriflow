import { Box, Flex, Grid } from "@chakra-ui/react";
import type { PageNavigation } from "@/lib/docs/navigation";
import type { ApiOperation, ParameterObject } from "@/lib/docs/openapi";
import { PageHeader } from "../page/page-header";
import { Pagination } from "../page/pagination";
import { ApiProvider } from "./api-state";
import type { ExampleLanguage, ExampleResponse } from "./examples";
import { Chip } from "./chip";
import { FieldList, FieldRow, Paragraph } from "./fields";
import { highlightCode } from "./highlight-code";
import { PathBar } from "./path-bar";
import { PlaygroundHost } from "./playground-host";
import { Examples } from "./request-panel";
import { specOf } from "./request-spec";
import { type ResponsePanel, ResponseSection } from "./response-section";
import { sampleValue } from "./sample";
import { smartQuotes } from "./schema";
import { SchemaFields, SchemaRow } from "./schema-fields";
import { Section } from "./section";
import { buildRequest, generateSnippet, LANGUAGES } from "./snippets";

export interface EndpointPageProps {
  href: string;
  operation: ApiOperation;
  navigation?: PageNavigation;
}

function ParameterSection({ title, parameters }: { title: string; parameters: ParameterObject[] }) {
  if (!parameters.length) return null;
  return (
    <Section title={title}>
      <FieldList>
        {parameters.map((parameter) =>
          parameter.schema ? (
            <SchemaRow
              key={parameter.name}
              anchorPrefix="parameter"
              trail={[]}
              path={[]}
              name={parameter.name}
              schema={{ ...parameter.schema, deprecated: parameter.deprecated ?? parameter.schema.deprecated }}
              required={parameter.required}
              description={parameter.description}
            />
          ) : null,
        )}
      </FieldList>
    </Section>
  );
}

/**
 * One API operation: its request and response as field rows, with the
 * examples beside them on wide screens (inline, after the path, below xl) and
 * a "Try it" playground. The examples are highlighted here, once, with
 * placeholders; the visitor's API key never reaches them.
 */
export async function EndpointPage({ href, operation, navigation }: EndpointPageProps) {
  const { operation: definition } = operation;
  const spec = specOf(operation);
  const { auth, contentType, bodySchema } = spec;
  const request = buildRequest(spec);

  const languages: ExampleLanguage[] = await Promise.all(
    LANGUAGES.map(async (language) => {
      const text = generateSnippet(language.id, request);
      return { id: language.id, label: language.label, text, node: await highlightCode(text, language.grammar) };
    }),
  );

  const statusCodes = Object.keys(definition.responses ?? {});
  const defaultStatus = statusCodes.find((code) => code.startsWith("2")) ?? statusCodes[0] ?? "200";
  const responseDetails = statusCodes.map((code) => {
    const response = definition.responses?.[code];
    const type = Object.keys(response?.content ?? {})[0];
    return { code, description: response?.description, contentType: type, schema: type ? response?.content?.[type]?.schema : undefined };
  });
  const responses: ExampleResponse[] = await Promise.all(
    responseDetails
      .filter((detail) => detail.schema)
      .map(async (detail) => {
        const text = JSON.stringify(sampleValue(detail.schema ?? {}), null, 2);
        return { code: detail.code, text, node: await highlightCode(text, "json") };
      }),
  );
  const panels: ResponsePanel[] = responseDetails.map((detail) => ({
    code: detail.code,
    description: detail.description,
    contentType: detail.contentType,
    rows: detail.schema ? (
      <SchemaFields schema={detail.schema} anchorPrefix={detail.code === defaultStatus ? "response" : `response-${detail.code}`} />
    ) : null,
  }));

  return (
    // Keyed so moving to another operation starts from a clean slate: no leftover inputs or status.
    <ApiProvider key={operation.href} spec={spec} title={operation.title} responses={responses} defaultStatus={defaultStatus}>
      <Grid
        templateAreas={{ base: '"head" "examples" "body"', xl: '"head examples" "body examples"' }}
        templateColumns={{ base: "minmax(0, 1fr)", xl: "minmax(0, 1fr) 440px" }}
        templateRows={{ xl: "auto 1fr" }}
        columnGap="12"
        rowGap="8"
      >
        <Flex gridArea="head" direction="column" gap="6">
          <PageHeader href={href} title={operation.title} description={operation.description ? smartQuotes(operation.description) : undefined} />
          <PathBar method={operation.method} path={operation.path} url={`${spec.origin}${operation.path}`} />
        </Flex>

        <Box gridArea="examples" minW="0">
          <Examples
            languages={languages}
            position={{ base: "static", xl: "sticky" }}
            top="6"
            maxH={{ xl: "calc(100dvh - 48px)" }}
          />
        </Box>

        <Flex gridArea="body" direction="column" gap="12" minW="0">
          {auth ? (
            <Section title="Authorization">
              <FieldList>
                <FieldRow
                  id="authorization-authorization"
                  name={auth.name}
                  pills={["string", auth.in]}
                  required
                  description={auth.description ? <Paragraph text={auth.description} /> : undefined}
                />
              </FieldList>
            </Section>
          ) : null}
          <ParameterSection title="Headers" parameters={spec.headers} />
          <ParameterSection title="Path parameters" parameters={spec.pathParams} />
          <ParameterSection title="Query parameters" parameters={spec.queryParams} />
          {bodySchema ? (
            <Section title="Body" aside={<Chip>{contentType}</Chip>}>
              <SchemaFields schema={bodySchema} anchorPrefix="body" />
            </Section>
          ) : null}
          {panels.length ? <ResponseSection panels={panels} /> : null}
        </Flex>
      </Grid>
      <Box mt="14">
        <Pagination prev={navigation?.prev} next={navigation?.next} />
      </Box>
      <PlaygroundHost bodyRequired={definition.requestBody?.required} />
    </ApiProvider>
  );
}
