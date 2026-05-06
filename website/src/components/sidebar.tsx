// Sidebar for the dashboard app shell — desktop aside + mobile drawer (vaul).
// Top: org switcher dropdown
// Middle: project list
// Bottom: user section with avatar, email, logout
//
// SidebarContent is the shared inner UI used by both the desktop <aside> and
// the mobile Drawer, so the project list / org switcher / user footer are
// never duplicated.

"use client";

import { useState, useEffect } from "react";
import { z } from "zod";
import { Drawer } from "vaul";
import { parseFormData } from "spiceflow";
import { router, Link, ErrorBoundary, useLoaderData } from "spiceflow/react";
import {
  PlusIcon,
  FolderIcon,
  FolderOpenIcon,
  ChevronsUpDownIcon,
  BuildingIcon,
  LogOutIcon,
  CheckIcon,
  MenuIcon,
} from "lucide-react";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "./ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPopup,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "./ui/dropdown-menu.tsx";
import { createProjectAction } from "../actions.ts";
import { authClient } from "../auth-client.ts";
import { StradaLogo } from "./strada-logo.tsx";

// ── Shared sidebar content ─────────────────────────────────────
function SidebarContent({
  onNavigate,
}: { onNavigate?: () => void }) {
  const { orgs, user } = useLoaderData('/dash/*');
  const orgData = useLoaderData('/dash/orgs/:orgId');
  const projectData = useLoaderData('/dash/projects/:projectId/*');
  const projects = projectData.projects ?? orgData.projects ?? [];
  const currentOrgId = projectData.orgId ?? orgData.orgId ?? null;
  const currentProjectId = projectData.projectId ?? null;
  const [showNewProject, setShowNewProject] = useState(false);

  const currentOrg = orgs.find((o) => o.id === currentOrgId);

  const userInitials = user?.name
    ? user.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "?";

  return (
    <>
      {/* ── Logo ─────────────────────────────────────────────── */}
      <Link href="/" onClick={onNavigate} className="text-foreground hover:opacity-80 transition-opacity mb-5 block">
        <StradaLogo className="h-6 w-auto" />
      </Link>

      {/* ── Org switcher ─────────────────────────────────────── */}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent",
          )}
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BuildingIcon className="size-4" />
          </div>
          <div className="grid flex-1 text-left leading-tight min-w-0">
            <span className="truncate font-medium text-sm">
              {currentOrg?.name || "Select org"}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {currentOrg?.role || "No organization"}
            </span>
          </div>
          <ChevronsUpDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuPopup side="bottom" align="start" sideOffset={4}>
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {orgs.map((org) => (
            <DropdownMenuLinkItem
              key={org.id}
              href={router.href('/dash/orgs/:orgId', { orgId: org.id })}
              onClick={onNavigate}
            >
              <div className="flex size-6 items-center justify-center rounded-md border">
                <BuildingIcon className="size-3.5 shrink-0" />
              </div>
              <span className="flex-1 truncate">{org.name}</span>
              {org.id === currentOrgId && (
                <CheckIcon className="size-3.5 text-muted-foreground" />
              )}
            </DropdownMenuLinkItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLinkItem href={router.href('/dash/new-org')} onClick={onNavigate}>
            <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
              <PlusIcon className="size-4" />
            </div>
            <span className="text-muted-foreground font-medium">
              Add organization
            </span>
          </DropdownMenuLinkItem>
        </DropdownMenuPopup>
      </DropdownMenu>

      {/* ── Projects ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto pt-4">
        <div className="mb-1 pl-2">
          <span className="text-xs font-medium text-muted-foreground">
            Projects
          </span>
        </div>

        <nav className="flex flex-col gap-0.5">
          {projects.map((project) => {
            const isActive = currentProjectId === project.id;
            const href = router.href('/dash/projects/:projectId', { projectId: project.id })
            return (
              <Link
                key={project.id}
                href={href}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent",
                  isActive && "bg-sidebar-accent text-primary font-medium",
                )}
              >
                {isActive ? (
                  <FolderOpenIcon className="size-4 shrink-0" />
                ) : (
                  <FolderIcon className="size-4 shrink-0 opacity-60" />
                )}
                {project.name}
              </Link>
            );
          })}
          {currentOrgId && (
            <button
              onClick={() => setShowNewProject(true)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground cursor-pointer"
            >
              <PlusIcon className="size-4 shrink-0 opacity-60" />
              New project
            </button>
          )}
          {!currentOrgId && (
            <p className="text-xs text-muted-foreground px-2 py-1.5">
              Select an org first
            </p>
          )}
        </nav>
      </div>

      {/* ── User footer ──────────────────────────────────────── */}
      <div className="border-t border-sidebar-border pt-4">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent",
            )}
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground font-medium text-xs">
              {userInitials}
            </div>
            <div className="grid flex-1 text-left leading-tight min-w-0">
              <span className="truncate font-medium text-sm">
                {user?.name || "Guest"}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {user?.email || ""}
              </span>
            </div>
            <ChevronsUpDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>

          <DropdownMenuPopup side="top" align="start" sideOffset={4}>
            {/* User info header */}
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground font-medium text-xs">
                {userInitials}
              </div>
              <div className="grid flex-1 leading-tight min-w-0">
                <span className="truncate font-medium text-sm">
                  {user?.name || "Guest"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {user?.email || ""}
                </span>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={async () => {
                await authClient.signOut();
                window.location.href = router.href("/login");
              }}
            >
              <LogOutIcon className="size-4 text-muted-foreground" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuPopup>
        </DropdownMenu>
      </div>

      {/* ── New project dialog ───────────────────────────────── */}
      <NewProjectDialog
        open={showNewProject}
        onOpenChange={setShowNewProject}
        orgId={currentOrgId}
      />
    </>
  );
}

// ── Desktop sidebar ────────────────────────────────────────────

export function Sidebar() {
  return (
    <aside className="hidden md:flex flex-col w-72 shrink-0 sticky top-0 h-screen min-h-0 border-r border-sidebar-border bg-background text-foreground p-6">
      <SidebarContent />
    </aside>
  );
}

// ── Mobile drawer (vaul) ───────────────────────────────────────

export function MobileDrawer() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen((prev) => !prev);
    window.addEventListener("strada:toggle-drawer", handler);
    return () => window.removeEventListener("strada:toggle-drawer", handler);
  }, []);

  return (
    <Drawer.Root direction="left" open={open} onOpenChange={setOpen}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40 md:hidden" />
        <Drawer.Content
          className="fixed inset-y-0 left-0 z-50 w-72 flex flex-col bg-background border-r border-sidebar-border p-6 md:hidden outline-none"
          aria-describedby={undefined}
        >
          <Drawer.Title className="sr-only">Navigation</Drawer.Title>
          <SidebarContent onNavigate={() => setOpen(false)} />
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

// ── New project dialog ─────────────────────────────────────────

const projectSchema = z.object({ name: z.string().min(1, "Name is required") });
const projectFields = projectSchema.keyof().enum;

export function NewProjectDialog({
  open,
  onOpenChange,
  orgId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Create a new project in this organization. Each project gets its own
            ingest endpoint and data isolation.
          </DialogDescription>
        </DialogHeader>
        <ErrorBoundary
          fallback={
            <div className="px-6 pb-4 flex flex-col gap-2">
              <ErrorBoundary.ErrorMessage className="text-sm text-destructive" />
              <ErrorBoundary.ResetButton className="text-sm text-destructive underline cursor-pointer self-start">
                Try again
              </ErrorBoundary.ResetButton>
            </div>
          }
        >
          <form
            className="px-6 pb-2"
            action={async (formData: FormData) => {
              if (!orgId) return;
              const { name } = parseFormData(projectSchema, formData);
              await createProjectAction({ name, orgId });
            }}
          >
            <Input
              name={projectFields.name}
              placeholder="Project name"
              required
              autoFocus
              className="w-full"
            />
            <DialogFooter variant="bare" className="mt-4">
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button type="submit">Create Project</Button>
            </DialogFooter>
          </form>
        </ErrorBoundary>
      </DialogPopup>
    </Dialog>
  );
}

// ── Mobile menu button ─────────────────────────────────────────

export function MobileMenuButton() {
  return (
    <button
      className="md:hidden flex items-center justify-center size-9 rounded-md hover:bg-accent transition-colors cursor-pointer"
      onClick={() => window.dispatchEvent(new CustomEvent("strada:toggle-drawer"))}
      aria-label="Open menu"
    >
      <MenuIcon className="size-5" />
    </button>
  );
}

// ── Standalone create-project button + dialog ──────────────────

export function NewProjectButton({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon className="size-4 mr-2" />
        Create project
      </Button>
      <NewProjectDialog
        open={open}
        onOpenChange={setOpen}
        orgId={orgId}
      />
    </>
  );
}
