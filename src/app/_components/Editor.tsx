"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import type { Editor } from "@tiptap/react";
import {
  Bold,
  Braces,
  Code,
  Heading2,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Quote,
} from "lucide-react";
import { useEffect } from "react";
import styles from "./Editor.module.css";

type EditorJSON = Record<string, unknown>;

type Props = {
  initialContent: EditorJSON | null;
  onChange: (json: EditorJSON) => void;
};

export function CardEditor({ initialContent, onChange }: Props) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: "Notes, checklists, links — anything you'd write down for this card.",
      }),
    ],
    content: initialContent ?? undefined,
    editorProps: {
      attributes: {
        class: styles.editor,
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getJSON() as EditorJSON);
    },
  });

  // Reset content when switching between different cards
  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(initialContent ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContent, editor]);

  return (
    <div className={styles.wrapper}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  return (
    <div className={styles.toolbar}>
      <ToolButton
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        label="Bold"
      >
        <Bold size={14} aria-hidden />
      </ToolButton>
      <ToolButton
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        label="Italic"
      >
        <Italic size={14} aria-hidden />
      </ToolButton>
      <ToolButton
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
        label="Inline code"
      >
        <Code size={14} aria-hidden />
      </ToolButton>
      <span className={styles.divider} />
      <ToolButton
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        label="Heading"
      >
        <Heading2 size={14} aria-hidden />
      </ToolButton>
      <ToolButton
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        label="Bullet list"
      >
        <List size={14} aria-hidden />
      </ToolButton>
      <ToolButton
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        label="Numbered list"
      >
        <ListOrdered size={14} aria-hidden />
      </ToolButton>
      <ToolButton
        active={editor.isActive("taskList")}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        label="Task list"
      >
        <ListChecks size={14} aria-hidden />
      </ToolButton>
      <span className={styles.divider} />
      <ToolButton
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        label="Quote"
      >
        <Quote size={14} aria-hidden />
      </ToolButton>
      <ToolButton
        active={editor.isActive("codeBlock")}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        label="Code block"
      >
        <Braces size={14} aria-hidden />
      </ToolButton>
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`${styles.toolBtn} ${active ? styles.toolBtnActive : ""}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
