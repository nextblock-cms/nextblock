import 'server-only';

import React from "react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Button } from "@nextblock-cms/ui";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@nextblock-cms/ui";
import { Badge } from "@nextblock-cms/ui";
import { MoreHorizontal, Edit3, Users, PlusCircle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuButtonTrigger,
} from "@nextblock-cms/ui";
import type { Database } from "@nextblock-cms/db";
import { isSandboxEnvironment } from "@nextblock-cms/db/server";
import { Avatar, AvatarFallback, AvatarImage } from "@nextblock-cms/ui";
import { requireCmsAdmin, type ServiceRoleClient } from "../../../lib/auth/cms-actor";
import { USERS_LOCKED_IN_SANDBOX, USERS_SANDBOX_NOTE_CLASS, USERS_SANDBOX_NOTE_ID } from "./sandbox-lock";

type AuthUser = {
    id: string;
    email: string | undefined;
    created_at: string | undefined;
    last_sign_in_at: string | undefined;
};
type UserWithProfile = {
    authUser: AuthUser;
    profile: Database['public']['Tables']['profiles']['Row'] | null;
};
import { DeleteUserButtonClient } from "./components/DeleteUserButton";

/**
 * Role badge: label and variant per role. `RTL` is the Affiliates partner role (migration 02029),
 * which the generated enum type does not know yet, so the role is compared as a string.
 */
function roleBadge(role: string | null | undefined): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  switch (String(role ?? "")) {
    case "ADMIN":
      return { label: "ADMIN", variant: "destructive" };
    case "WRITER":
      return { label: "WRITER", variant: "secondary" };
    case "RTL":
      return { label: "PARTNER (RTL)", variant: "default" };
    case "USER":
      return { label: "USER", variant: "outline" };
    default:
      return { label: role ? String(role) : "N/A", variant: "outline" };
  }
}

async function getUsersData(supabaseAdmin: ServiceRoleClient): Promise<UserWithProfile[]> {
  // Listing auth.users and every profile needs the service role (other accounts' profile rows
  // sit behind is_admin_mfa()); the caller has authorized the ADMIN with requireCmsAdmin().
  const { data: { users: authUsers }, error: usersError } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1000, // Adjust as needed, handle pagination for very large user bases
  });

  if (usersError) {
    console.error("Error fetching auth users:", JSON.stringify(usersError, null, 2));
    return [];
  }
  if (!authUsers) return [];

  // Fetch all profiles
  // Use admin client to bypass RLS policies so we can see all user profiles
  const { data: profiles, error: profilesError } = await supabaseAdmin
    .from("profiles")
    .select("*");

  if (profilesError) {
    console.error("Error fetching profiles:", JSON.stringify(profilesError, null, 2));
    // Continue without profiles if there's an error, or handle differently
  }

  const profilesMap = new Map(profiles?.map(p => [p.id, p]));

  return authUsers.map(authUser => {
    // Simplify authUser to only include necessary fields to avoid sending too much data
    const simplifiedAuthUser: AuthUser = {
        id: authUser.id,
        email: authUser.email,
        created_at: authUser.created_at,
        last_sign_in_at: authUser.last_sign_in_at,
    };
    return {
      authUser: simplifiedAuthUser,
      profile: profilesMap.get(authUser.id) || null,
    };
  });
}

export default async function CmsUsersListPage() {
  // The proxy and the CMS layout already gate this route; this is the check the service-role
  // reads below rely on (session, ADMIN role, second factor satisfied).
  let admin: Awaited<ReturnType<typeof requireCmsAdmin>>;
  try {
    admin = await requireCmsAdmin();
  } catch (error) {
    unstable_rethrow(error);
    return error instanceof Error && error.message === 'Unauthorized'
      ? <p>Access Denied. Not authenticated.</p>
      : <p>Access Denied. Admin privileges required.</p>;
  }
  const currentAdmin = { id: admin.userId };

  const users = await getUsersData(admin.supabase);
  // The public sandbox shares every account with every visitor: the actions refuse every change
  // there, and each row's disabled Delete item points at this note (aria-describedby).
  const sandboxLocked = isSandboxEnvironment();

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">Manage Users</h1>
        <Button asChild>
          <Link href="/cms/users/new" className="flex items-center">
            <PlusCircle className="mr-2 h-4 w-4" /> Create User
          </Link>
        </Button>
      </div>
      {sandboxLocked && (
        <p id={USERS_SANDBOX_NOTE_ID} className={USERS_SANDBOX_NOTE_CLASS}>
          {USERS_LOCKED_IN_SANDBOX}
        </p>
      )}

      {users.length === 0 ? (
        <div className="text-center py-10 border rounded-lg">
          <Users className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-2 text-sm font-medium text-foreground">No other users found</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a user, or new users will appear here after they sign up.
          </p>
          <Button asChild className="mt-4">
            <Link href="/cms/users/new" className="flex items-center">
              <PlusCircle className="mr-2 h-4 w-4" /> Create User
            </Link>
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[80px]">Avatar</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Full Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="text-right w-[80px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map(({ authUser, profile }) => (
                <TableRow key={authUser.id}>
                  <TableCell>
                     <Avatar className="h-9 w-9">
                        <AvatarImage src={profile?.avatar_url || undefined} alt={profile?.full_name || authUser.email} />
                        <AvatarFallback>{authUser.email?.charAt(0).toUpperCase() || 'U'}</AvatarFallback>
                    </Avatar>
                  </TableCell>
                  <TableCell className="font-medium">{authUser.email}</TableCell>
                  <TableCell className="text-muted-foreground">{profile?.full_name || "N/A"}</TableCell>
                  <TableCell>
                    <Badge variant={roleBadge(profile?.role).variant}>
                      {roleBadge(profile?.role).label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {authUser.created_at ? new Date(authUser.created_at).toLocaleDateString() : "N/A"}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuButtonTrigger id={`user-trigger-${authUser.id}`}>
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">User actions</span>
                      </DropdownMenuButtonTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/cms/users/${authUser.id}/edit`} className="flex items-center">
                            <Edit3 className="mr-2 h-4 w-4" /> Edit Role/Profile
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DeleteUserButtonClient userId={authUser.id} userEmail={authUser.email} currentAdminId={currentAdmin.id} />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}