"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Flex } from "@chakra-ui/react";
import { X } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Select, type SelectOption } from "@narriflow/ui/components/select";
import { Spinner } from "@narriflow/ui/components/spinner";

export interface CalendarFilter {
  name: "status" | "platform" | "account" | "project";
  label: string;
  /** The "All …" option first; its value is "". */
  items: SelectOption[];
  width: string;
}

/** Filters apply as soon as one changes; the URL keeps them, so a view can be shared. */
export function CalendarFilters({ filters }: { filters: CalendarFilter[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const active = filters.filter((filter) => params.get(filter.name));

  function navigate(next: URLSearchParams) {
    startTransition(() => router.replace(`${pathname}?${next}`, { scroll: false }));
  }
  function set(name: CalendarFilter["name"], value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(name, value);
    else next.delete(name);
    navigate(next);
  }
  function clear() {
    const next = new URLSearchParams(params.toString());
    for (const filter of filters) next.delete(filter.name);
    navigate(next);
  }

  return (
    <Flex gap="2" wrap="wrap" align="center">
      {filters.map((filter) => (
        <Select
          key={filter.name}
          ariaLabel={filter.label}
          size="sm"
          w={filter.width}
          items={filter.items}
          value={params.get(filter.name) ?? ""}
          onValueChange={(value) => set(filter.name, value)}
        />
      ))}
      {active.length > 0 ? (
        <Button size="sm" variant="ghost" onClick={clear}>
          <X size={13} /> Clear {active.length === 1 ? "filter" : `${active.length} filters`}
        </Button>
      ) : null}
      {pending ? <Spinner size="xs" /> : null}
    </Flex>
  );
}
