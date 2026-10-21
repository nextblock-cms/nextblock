import 'server-only';

import React from "react";
import { createClient } from "@nextblock-cms/db/server";
import Link from "next/link";
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
import { Avatar, AvatarFallback, AvatarImage } from "@nextblock-cms/ui";

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

async function getUsersData(currentAdminId: string): Promise<UserWithProfile[]> {
  // This needs to use a service role client to list all users from auth.users
  const { createClient: createServiceRoleClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing required environment variables');
  }
  
  const supabaseAdmin = createServiceRoleClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

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
  const supabase = createClient();
  const { data: { user: currentAdmin } } = await supabase.auth.getUser();

  if (!currentAdmin) {
      // This should ideally be caught by middleware or layout auth checks
      return <p>Access Denied. Not authenticated.</p>;
  }
  // Further check if current user is admin (already done by layout, but good for direct access attempts)
  const { data: adminProfile } = await supabase.from('profiles').select('role').eq('id', currentAdmin.id).single();
  if (adminProfile?.role !== 'ADMIN') {
      return <p>Access Denied. Admin privileges required.</p>;
  }

  const users = await getUsersData(currentAdmin.id);

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
                    <Badge variant={
                        profile?.role === "ADMIN" ? "destructive" :
                        profile?.role === "WRITER" ? "secondary" : "outline"
                    }>
                      {profile?.role || "N/A"}
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