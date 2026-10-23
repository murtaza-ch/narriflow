import { PageHeader as KitPageHeader } from "@narriflow/ui/components/page-header";
import { CopyPageMenu } from "./copy-page-menu";

export interface PageHeaderProps {
  /** Page path, e.g. "/docs/ai/claude"; the Copy page menu reads `${href}.md`. */
  href: string;
  title: string;
  description?: string;
}

/** The app's page header, with the Copy page menu in its action slot. */
export function PageHeader({ href, title, description }: PageHeaderProps) {
  return <KitPageHeader title={title} description={description} actions={<CopyPageMenu href={href} />} />;
}
