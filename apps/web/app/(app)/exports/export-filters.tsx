"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Box, chakra, Flex } from "@chakra-ui/react";
import { Search, X } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { DatePicker } from "@narriflow/ui/components/date-picker";
import { Select } from "@narriflow/ui/components/select";
import { Spinner } from "@narriflow/ui/components/spinner";

const FILTER_KEYS = ["q", "project", "ratio", "from", "to"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/** Filters apply as they change (search after a short pause); the URL keeps them. */
export function ExportFilters({ projects }: { projects: { id: string; title: string }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  function apply(changes: Partial<Record<FilterKey, string>>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // A new filter starts from the newest page.
    next.delete("cursor");
    const search = next.toString();
    startTransition(() => router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false }));
  }

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  function typeQuery(value: string) {
    setQuery(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => apply({ q: value.trim() }), 350);
  }

  const active = FILTER_KEYS.filter((key) => params.get(key)).length;
  return (
    <Flex gap="2" wrap="wrap" align="center">
      <Flex
        align="center"
        gap="2"
        h="9"
        ps="3"
        pe="1"
        flex={{ base: "1 1 100%", md: "1 1 240px" }}
        maxW={{ md: "340px" }}
        bg="bg.soft"
        borderRadius="control"
        borderWidth="1px"
        borderColor="transparent"
        color="fg.muted"
        _focusWithin={{ borderColor: "border.focus" }}
      >
        <Search size={14} aria-hidden />
        <chakra.input
          aria-label="Search exports"
          placeholder="Search clips or projects"
          value={query}
          onChange={(event) => typeQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") apply({ q: query.trim() });
          }}
          flex="1"
          minW="0"
          h="full"
          bg="transparent"
          fontSize="13px"
          color="fg"
          outline="none"
          _placeholder={{ color: "fg.subtle" }}
        />
        {query ? (
          <Button size="xs" variant="ghost" aria-label="Clear search" onClick={() => { setQuery(""); apply({ q: "" }); }}>
            <X size={12} />
          </Button>
        ) : null}
      </Flex>
      <Select
        ariaLabel="Project"
        size="sm"
        w="200px"
        value={params.get("project") ?? ""}
        onValueChange={(value) => apply({ project: value })}
        items={[{ value: "", label: "All projects" }, ...projects.map((project) => ({ value: project.id, label: project.title }))]}
      />
      <Select
        ariaLabel="Format"
        size="sm"
        w="140px"
        value={params.get("ratio") ?? ""}
        onValueChange={(value) => apply({ ratio: value })}
        items={[
          { value: "", label: "All formats" },
          { value: "ratio_9_16", label: "9:16" },
          { value: "ratio_1_1", label: "1:1" },
          { value: "ratio_16_9", label: "16:9" },
          { value: "ratio_4_5", label: "4:5" },
        ]}
      />
      <Box w="150px">
        <DatePicker ariaLabel="From date" placeholder="From" width="100%" value={params.get("from") ?? ""} onValueChange={(value) => apply({ from: value })} max={params.get("to") ?? undefined} />
      </Box>
      <Box w="150px">
        <DatePicker ariaLabel="To date" placeholder="To" width="100%" value={params.get("to") ?? ""} onValueChange={(value) => apply({ to: value })} min={params.get("from") ?? undefined} />
      </Box>
      {active > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setQuery("");
            apply({ q: "", project: "", ratio: "", from: "", to: "" });
          }}
        >
          <X size={13} /> Clear {active === 1 ? "filter" : `${active} filters`}
        </Button>
      ) : null}
      {pending ? <Spinner size="xs" /> : null}
    </Flex>
  );
}
