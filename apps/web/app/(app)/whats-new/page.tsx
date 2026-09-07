import { Stack } from "@chakra-ui/react";
import { Sparkles } from "lucide-react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { EmptyState } from "@narriflow/ui/components/empty-state";
export default function WhatsNewPage() {
  return <Stack gap="8"><PageHeader title="What's new" description="Updates to your Narriflow workspace." /><EmptyState icon={<Sparkles size={24} />} title="No release notes yet" description="New features and improvements will appear here." /></Stack>;
}
