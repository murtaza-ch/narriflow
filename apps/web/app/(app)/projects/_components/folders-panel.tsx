"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Flex, Input, Stack, Text } from "@chakra-ui/react";
import { Folder, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { createFolderAction, deleteFolderAction, moveProjectToFolderAction, renameFolderAction } from "../actions";

export function FoldersPanel({
  folders,
  activeFolderId,
  canEdit,
}: {
  folders: Array<{ id: string; name: string; count: number }>;
  activeFolderId: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [pending, startTransition] = useTransition();

  function save() {
    if (!name.trim()) return setError("Enter a folder name");
    startTransition(async () => {
      const result = await createFolderAction(name);
      if (!result.ok) return setError(result.error);
      setCreating(false);
      setName("");
      setError(null);
      router.refresh();
    });
  }

  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") { event.preventDefault(); save(); }
    if (event.key === "Escape") { setCreating(false); setName(""); setError(null); }
  }

  function saveRename(folderId: string) {
    if (!editingName.trim()) return setError("Enter a folder name");
    startTransition(async () => {
      const result = await renameFolderAction(folderId, editingName);
      if (!result.ok) return setError(result.error);
      setEditingId(null);
      setEditingName("");
      setError(null);
      router.refresh();
    });
  }

  function dropProject(event: React.DragEvent, folderId: string | null) {
    event.preventDefault();
    const projectId = event.dataTransfer.getData("application/x-narriflow-project");
    if (!projectId) return;
    startTransition(async () => {
      await moveProjectToFolderAction(projectId, folderId);
      router.refresh();
    });
  }

  return (
    <Stack gap="3">
      <Flex align="center" justify="space-between"><Text textStyle="eyebrow" color="fg.subtle">Folders</Text>{canEdit ? <Button size="xs" variant="ghost" onClick={() => setCreating(true)}><FolderPlus size={14} />New folder</Button> : null}</Flex>
      {creating ? (
        <Stack gap="1"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={keyDown} onBlur={() => { if (name.trim()) save(); }} maxLength={80} placeholder="Folder name" disabled={pending} />{error ? <Text fontSize="11px" color="danger.fg">{error}</Text> : null}</Stack>
      ) : null}
      <Flex gap="2" overflowX="auto" pb="1">
        <Flex onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropProject(event, null)}>
          <Button size="xs" variant={!activeFolderId ? "outline" : "ghost"} asChild><Link href="/projects"><Folder size={13} />All projects</Link></Button>
        </Flex>
        {folders.map((folder) => (
          <Flex key={folder.id} align="center" flexShrink={0} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropProject(event, folder.id)}>
            {editingId === folder.id ? (
              <Input
                autoFocus
                size="sm"
                value={editingName}
                maxLength={80}
                onChange={(event) => setEditingName(event.target.value)}
                onBlur={() => { if (editingName.trim()) saveRename(folder.id); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); saveRename(folder.id); }
                  if (event.key === "Escape") { setEditingId(null); setEditingName(""); setError(null); }
                }}
                disabled={pending}
              />
            ) : (
              <Button size="xs" variant={activeFolderId === folder.id ? "outline" : "ghost"} asChild><Link href={`/projects?folder=${folder.id}`}><Folder size={13} />{folder.name} <Text as="span" color="fg.subtle">{folder.count}</Text></Link></Button>
            )}
            {canEdit && editingId !== folder.id ? (
              <Button size="xs" variant="ghost" aria-label={`Rename ${folder.name}`} onClick={() => { setEditingId(folder.id); setEditingName(folder.name); }} disabled={pending}><Pencil size={12} /></Button>
            ) : null}
            {canEdit && editingId !== folder.id ? <Button size="xs" variant="ghost" aria-label={`Delete ${folder.name}`} onClick={() => { if (!window.confirm(`Delete ${folder.name}? Its projects will move to All projects.`)) return; startTransition(async () => { await deleteFolderAction(folder.id); router.push("/projects"); router.refresh(); }); }} disabled={pending}>{pending ? <Spinner size="xs" /> : <Trash2 size={12} />}</Button> : null}
          </Flex>
        ))}
      </Flex>
      {error && !creating ? <Text fontSize="11px" color="danger.fg">{error}</Text> : null}
    </Stack>
  );
}
