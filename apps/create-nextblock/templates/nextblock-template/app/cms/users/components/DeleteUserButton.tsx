// app/cms/users/components/DeleteUserButton.tsx
"use client"; // This is crucial

import React, { useState, useTransition } from "react";
import { DropdownMenuItem } from "@nextblock-cms/ui";
import { Trash2, ShieldAlert } from "lucide-react";
import { deleteUserAndProfile } from "../actions";
import { ConfirmationModal } from '../../components/ConfirmationModal';
import { USERS_SANDBOX_NOTE_ID } from "../sandbox-lock";

export function DeleteUserButtonClient({
  userId,
  userEmail,
  currentAdminId,
}: {
  userId: string;
  userEmail?: string;
  currentAdminId?: string;
}) {
  void userEmail;
  const [isPending, startTransition] = useTransition();
  const [isModalOpen, setIsModalOpen] = useState(false);
  // The public sandbox shares every account with every visitor, so deleteUserAndProfile refuses
  // there: the item renders disabled, described by the note on the users list page. Read inline,
  // as SandboxCredentialsAlert does.
  const sandboxLocked = process.env.NEXT_PUBLIC_IS_SANDBOX === "true";

  const handleDelete = () => {
    if (userId === currentAdminId) {
      alert("Admins cannot delete their own account through this panel.");
      setIsModalOpen(false);
      return;
    }
    startTransition(async () => {
      const result = await deleteUserAndProfile(userId);
      if (result?.error) {
        alert(`Error: ${result.error}`);
      }
      setIsModalOpen(false);
    });
  };

  return (
    <>
      <DropdownMenuItem
        className={`text-red-600 hover:!text-red-600 hover:!bg-red-50 dark:hover:!bg-red-700/20 ${
          userId === currentAdminId ? "opacity-50 cursor-not-allowed" : ""
        }`}
        onSelect={(e) => {
          e.preventDefault();
          if (!sandboxLocked && userId !== currentAdminId) setIsModalOpen(true);
        }}
        disabled={sandboxLocked || userId === currentAdminId}
        aria-describedby={sandboxLocked ? USERS_SANDBOX_NOTE_ID : undefined}
      >
        <Trash2 className="mr-2 h-4 w-4" />
        Delete User
        {userId === currentAdminId && (
          <span title="You cannot delete your own account.">
            <ShieldAlert
              className="ml-auto h-4 w-4 text-yellow-500"
              aria-label="You cannot delete your own account."
            />
          </span>
        )}
      </DropdownMenuItem>
      <ConfirmationModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onConfirm={handleDelete}
        title="Are you sure?"
        description="This will permanently delete the user. This action cannot be undone."
        confirmText={isPending ? "Deleting..." : "Confirm"}
      />
    </>
  );
}
