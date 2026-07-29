/**
 * The one face-status query (`GET /api/face/status`) shared by every gate/checklist/dialog call
 * site, so they all hit the same React Query cache entry.
 *
 * WHY the staleTime: this is polled from many mounts (dashboard checklist, timesheet submit,
 * ticket create/status, kanban, approvals, the verification dialog), and the default
 * staleTime of 0 refetches on every mount — pure chatter, since the server re-checks the policy
 * on every protected request anyway and answers 428 if the client's picture was stale. A
 * 60-second window keeps SPA navigation quiet without meaningfully delaying an admin's policy
 * change reaching the UI.
 */
import { useQuery } from "@tanstack/react-query";
import { faceApi } from "../services/api";

export function useFaceStatus(enabled = true) {
  return useQuery({ queryKey: ["face", "status"], queryFn: faceApi.status, staleTime: 60_000, enabled });
}
