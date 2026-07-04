/**
 * Kanban board view for Tickets.tsx — one droppable column per TicketStatus, draggable cards.
 * WHY dropping a card just calls the existing status-update endpoint (no new backend route):
 * the server already owns the "is this transition legal" rule (`ticketStatusTransitions`), so
 * reusing it means the board can never drift out of sync with what the list view enforces.
 * HOW an illegal drop "snaps back": columns render straight off the React Query cache, never
 * local drag state, so when a rejected transition's mutation fails, invalidating the cache
 * just re-fetches the *unchanged* server state — the card visually returns on its own, no
 * explicit revert logic needed.
 * `PointerSensor`'s 8px activation distance is what lets a plain click (open the ticket) and a
 * real drag (move columns) coexist on the same card without one interpreting as the other.
 */
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Mail } from "lucide-react";
import { useState } from "react";
import { ticketStatuses, type TicketStatus } from "@timesheet/shared";
import { iconForType, initialsFor, PRIORITY_VARIANT, serverMessage, STATUS_VARIANT } from "../pages/Tickets";
import { fileUrl, ticketApi, type TicketRow } from "../services/api";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { toast } from "./ui/toaster";

const COLUMN_LABEL: Record<TicketStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  IN_REVIEW: "In review",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REOPENED: "Reopened"
};

function TicketCard({ ticket }: { ticket: TicketRow }) {
  const TypeIcon = iconForType(ticket.type);
  const avatarSrc = fileUrl(ticket.assignee?.avatarUrl);
  return (
    <div className="grid gap-2 rounded-lg border border-border bg-card p-3 text-sm shadow-sm">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-mono">{ticket.key}</span>
        {ticket.source === "EMAIL" && <Mail className="h-3 w-3" />}
        {ticket.needsReview && <AlertTriangle className="h-3 w-3 text-warning" />}
      </div>
      <p className="line-clamp-2 font-medium leading-snug">{ticket.title}</p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <TypeIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <Badge variant={PRIORITY_VARIANT[ticket.priority]}>{ticket.priority}</Badge>
        </div>
        {ticket.assignee ? (
          <Avatar className="h-6 w-6">
            {avatarSrc ? <AvatarImage src={avatarSrc} alt={ticket.assignee.name} /> : null}
            <AvatarFallback className="text-[10px]">{initialsFor(ticket.assignee.name)}</AvatarFallback>
          </Avatar>
        ) : (
          <span className="text-[10px] text-muted-foreground">Unassigned</span>
        )}
      </div>
    </div>
  );
}

function DraggableCard({ ticket, onOpen }: { ticket: TicketRow; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: ticket.id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => !isDragging && onOpen(ticket.id)}
      className="cursor-grab touch-none active:cursor-grabbing"
      style={{
        opacity: isDragging ? 0.4 : 1,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined
      }}
    >
      <TicketCard ticket={ticket} />
    </div>
  );
}

function KanbanColumn({ status, tickets, onOpen }: { status: TicketStatus; tickets: TicketRow[]; onOpen: (id: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className={`grid w-72 shrink-0 auto-rows-min gap-2 rounded-lg border p-2 transition-colors ${isOver ? "border-primary bg-primary/5" : "border-border bg-muted/20"}`}
    >
      <div className="flex items-center justify-between px-1 py-1">
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[status]}>{COLUMN_LABEL[status]}</Badge>
        </div>
        <span className="text-xs text-muted-foreground">{tickets.length}</span>
      </div>
      <div className="grid max-h-[70vh] gap-2 overflow-y-auto pb-2">
        {tickets.map((t) => (
          <DraggableCard key={t.id} ticket={t} onOpen={onOpen} />
        ))}
        {tickets.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">No tickets</p>}
      </div>
    </div>
  );
}

export function TicketKanban({ tickets, onOpenTicket }: { tickets: TicketRow[]; onOpenTicket: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const moveStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TicketStatus }) => ticketApi.updateStatus(id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tickets"] }),
    onError: (err: any) => toast.error("Couldn't move ticket", { description: serverMessage(err, "That status change isn't allowed.") })
  });

  const byStatus: Record<TicketStatus, TicketRow[]> = {
    OPEN: [], IN_PROGRESS: [], IN_REVIEW: [], RESOLVED: [], CLOSED: [], REOPENED: []
  };
  for (const t of tickets) byStatus[t.status].push(t);

  const activeTicket = tickets.find((t) => t.id === activeId) ?? null;

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const ticket = tickets.find((t) => t.id === active.id);
    const newStatus = over.id as TicketStatus;
    if (!ticket || ticket.status === newStatus) return;
    moveStatus.mutate({ id: ticket.id, status: newStatus });
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex gap-3 overflow-x-auto pb-2">
        {ticketStatuses.map((status) => (
          <KanbanColumn key={status} status={status} tickets={byStatus[status]} onOpen={onOpenTicket} />
        ))}
      </div>
      <DragOverlay>{activeTicket ? <div className="w-72"><TicketCard ticket={activeTicket} /></div> : null}</DragOverlay>
    </DndContext>
  );
}
