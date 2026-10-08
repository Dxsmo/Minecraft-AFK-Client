import type { JSONContent } from "@tiptap/react";

export interface NoteUser { id: string; username: string }
export interface NoteGrant { userId: string; canWrite: boolean; user: NoteUser }
export interface NoteSummary {
  id: string;
  title: string;
  ownerId: string;
  owner: NoteUser;
  revision: number;
  updatedAt: string;
  createdAt: string;
  canWrite: boolean;
  isOwner: boolean;
  shared: boolean;
  grants: NoteGrant[];
}
export interface Note extends NoteSummary { content: JSONContent }
