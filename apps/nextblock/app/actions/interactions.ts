"use server";

import "server-only";

import { createClient, getServiceRoleSupabaseClient, getProfileWithRoleServerSide } from "@nextblock-cms/db/server";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requireCmsAdmin } from "../../lib/auth/cms-actor";
import { resolveSiteUrl } from "../../lib/site-url";
import { sendEmail } from "./email";

export interface SubmitInteractionInput {
  type: "review" | "comment";
  content: string;
  rating?: number;
  productId?: string;
  postId?: number;
}

// Self-submitted rows always land as 'pending', and nothing stops one account from
// piling thousands of them into the moderation queue (and, where notification emails
// are configured, mailing the moderators once per row). Cap what one user may have
// waiting: a burst limit over a short window and a hard ceiling on the backlog.
const PENDING_WINDOW_MINUTES = 10;
const PENDING_MAX_PER_WINDOW = 5;
const PENDING_MAX_TOTAL = 50;
// Deliberately generic: it does not say which limit was hit or where it sits.
const SUBMISSION_THROTTLED_MESSAGE =
  "You have submitted several reviews or comments recently. Please wait a while before submitting another.";

// Reactions are an allowlist, not free text: the key is written straight into the
// `reactions` JSONB and read back by the public UI as `reactions.likes`.
const REACTION_TYPES = new Set(["likes"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Submits a new comment or review. Default status is 'pending' for moderation.
 */
export async function submitInteraction(input: SubmitInteractionInput) {
  const supabase = createClient();

  // 1. Authenticate user
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return { error: "You must be logged in to submit a review or comment." };
  }

  // 2. Validate inputs
  if (!input.content || input.content.trim().length < 5) {
    return { error: "Content must be at least 5 characters long." };
  }

  if (input.type === "review") {
    if (!input.productId) {
      return { error: "Product ID is required for a review." };
    }
    if (!input.rating || input.rating < 1 || input.rating > 5) {
      return { error: "Rating must be between 1 and 5 stars." };
    }
  } else if (input.type === "comment") {
    if (!input.postId) {
      return { error: "Post ID is required for a comment." };
    }
  } else {
    return { error: "Invalid interaction type." };
  }

  try {
    // 3. Throttle. A plain USER cannot read their own pending rows (the read policy is
    // approved-only below staff), so the count has to run as the service role. One
    // query serves both limits: the newest PENDING_MAX_TOTAL rows are enough to decide
    // the ceiling (hitting the cap means the ceiling is reached), and every row inside
    // the burst window is necessarily among the newest. Fails closed: a limit that
    // cannot be checked is not enforced.
    const admin = getServiceRoleSupabaseClient();
    const since = Date.now() - PENDING_WINDOW_MINUTES * 60_000;
    const { data: pendingRows, error: pendingError } = await admin
      .from("cms_interactions")
      .select("created_at")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(PENDING_MAX_TOTAL);

    if (pendingError) {
      console.error("Error checking interaction submission limits:", pendingError);
      return { error: "Could not submit right now. Please try again later." };
    }

    const pending = pendingRows ?? [];
    const recent = pending.filter((row) => {
      const createdAt = Date.parse(row.created_at);
      return Number.isFinite(createdAt) && createdAt >= since;
    });
    if (pending.length >= PENDING_MAX_TOTAL || recent.length >= PENDING_MAX_PER_WINDOW) {
      return { error: SUBMISSION_THROTTLED_MESSAGE };
    }

    // 4. Insert interaction. No `.select()`: that adds RETURNING, and Postgres checks
    // a returned row against the SELECT policy, which only shows a USER approved rows.
    // The insert itself passes the INSERT policy; asking for the row back is what made
    // every customer submission fail with an RLS violation. Nothing reads the row.
    const { error } = await supabase
      .from("cms_interactions" as any)
      .insert({
        type: input.type,
        status: "pending",
        content: input.content.trim(),
        rating: input.type === "review" ? input.rating : null,
        user_id: user.id,
        product_id: input.type === "review" ? input.productId : null,
        post_id: input.type === "comment" ? input.postId : null,
        reactions: {},
      });

    if (error) {
      console.error("Error inserting interaction:", error);
      return { error: `Failed to submit: ${error.message}` };
    }

    // 5. Revalidate moderation panel path
    revalidatePath("/cms/interactions");

    // 6. Send email notification asynchronously if emails are configured
    try {
      if (admin) {
        const { data: config } = await admin
          .from("site_settings")
          .select("value")
          .eq("key", "interactions_notification_emails")
          .maybeSingle();

        const emailsString = (config?.value as any)?.emails || "";

        if (emailsString) {
          // The dashboard link comes from the configured site URL, never from the
          // request's Host/Origin header: on a self-hosted or proxied install that
          // header is whatever the submitter sent, which put an attacker-chosen domain
          // (or raw markup) inside the moderators' own notification mail.
          const dashboardUrl = `${resolveSiteUrl()}/cms/interactions`;

          const capitalizedType = input.type.charAt(0).toUpperCase() + input.type.slice(1);
          const subject = `New Pending ${capitalizedType} Submitted`;

          const html = `
            <div style="font-family: sans-serif; padding: 20px; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 8px;">
              {{brand_header}}
              <h2 style="color: #6366f1; margin-top: 0;">New Pending ${capitalizedType} Submitted</h2>
              <p>Hello,</p>
              <p>A new content interaction has been submitted and is currently <strong>pending moderation</strong>.</p>
              <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
              <div style="background-color: #f9fafb; padding: 15px; border-radius: 6px; margin-bottom: 20px;">
                <p style="margin: 0 0 8px 0;"><strong>Type:</strong> ${capitalizedType}</p>
                ${input.type === "review" && input.rating ? `<p style="margin: 0 0 8px 0;"><strong>Rating:</strong> ${input.rating} / 5</p>` : ""}
                <p style="margin: 0 0 8px 0;"><strong>Content:</strong></p>
                <blockquote style="margin: 0; padding-left: 10px; border-left: 3px solid #6366f1; color: #555; font-style: italic;">
                  ${escapeHtml(input.content.trim())}
                </blockquote>
              </div>
              <p>Please log in to the moderation dashboard to approve or deny this interaction:</p>
              <p style="margin-top: 20px;">
                <a href="${escapeHtml(dashboardUrl)}" style="background-color: #6366f1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                  Go to Moderation Dashboard
                </a>
              </p>
              <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
              <p style="font-size: 11px; color: #888;">This is an automated notification from your CMS.</p>
            </div>
          `;

          const text = `
New Pending ${capitalizedType} Submitted

A new ${input.type} has been submitted and is currently pending moderation.

Type: ${capitalizedType}
${input.type === "review" && input.rating ? `Rating: ${input.rating} / 5\n` : ""}
Content: "${input.content.trim()}"

Moderation Dashboard: ${dashboardUrl}
          `;

          sendEmail({
            to: emailsString,
            subject,
            text,
            html,
          }).catch((err) =>
            console.error("Failed to send pending interaction email notification:", err)
          );
        }
      }
    } catch (emailErr) {
      console.error("Failed to process email notifications:", emailErr);
    }

    return { success: true };
  } catch (err: any) {
    console.error("Submit interaction failed:", err);
    return { error: err.message || "An unexpected error occurred." };
  }
}

/**
 * Toggles a reaction (like) on a comment or review.
 *
 * Signed-in users only. The write runs as the service role (visitors hold no UPDATE
 * policy on `cms_interactions`), and a server action is a public POST endpoint, so
 * the action itself has to establish who is calling before it touches the row.
 * Duplicate prevention is still the `reacted_interactions` cookie the public UI reads
 * to draw the "liked" state; it is a convenience, not a security control.
 */
export async function toggleReaction(interactionId: string, reactionType = "likes") {
  if (typeof interactionId !== "string" || !UUID_RE.test(interactionId)) {
    return { error: "Interaction ID is required." };
  }
  if (typeof reactionType !== "string" || !REACTION_TYPES.has(reactionType)) {
    return { error: "Unsupported reaction." };
  }

  try {
    const supabase = createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return { error: "You must be logged in to react." };
    }

    // Duplicate prevention using cookies
    const cookieStore = await cookies();
    const reactedCookie = cookieStore.get("reacted_interactions")?.value;
    let reactedList: string[] = [];

    try {
      if (reactedCookie) {
        const parsed: unknown = JSON.parse(reactedCookie);
        if (Array.isArray(parsed)) {
          reactedList = parsed.filter((id): id is string => typeof id === "string");
        }
      }
    } catch {
      reactedList = [];
    }

    const hasReacted = reactedList.includes(interactionId);

    // Call service role client since visitors don't have update RLS policies
    const admin = getServiceRoleSupabaseClient();

    // Fetch current reactions. Only published rows can be reacted to: a pending or
    // denied row is invisible on the site, and this lookup bypasses RLS.
    const { data: interaction, error: fetchError } = await admin
      .from("cms_interactions")
      .select("reactions, type, product_id, post_id, products(slug), posts(slug)")
      .eq("id", interactionId)
      .eq("status", "approved")
      .single();

    if (fetchError || !interaction) {
      return { error: "Interaction not found." };
    }

    const reactions = (interaction.reactions as Record<string, number>) || {};
    const storedCount = Number(reactions[reactionType]);
    // Clamp whatever is stored to a non-negative integer so a malformed value can
    // neither go negative nor carry a fraction, and a single toggle moves it by one.
    const currentCount = Number.isFinite(storedCount) && storedCount > 0 ? Math.floor(storedCount) : 0;
    const newCount = hasReacted ? Math.max(0, currentCount - 1) : currentCount + 1;
    reactions[reactionType] = newCount;

    // Save back to db
    const { error: updateError } = await admin
      .from("cms_interactions")
      .update({ reactions })
      .eq("id", interactionId);

    if (updateError) {
      console.error("Error updating reactions:", updateError);
      return { error: "Failed to update reaction." };
    }

    // Update the cookie
    if (hasReacted) {
      reactedList = reactedList.filter(id => id !== interactionId);
    } else {
      reactedList.push(interactionId);
    }
    
    cookieStore.set("reacted_interactions", JSON.stringify(reactedList), {
      maxAge: 60 * 60 * 24 * 365, // 1 year
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });

    // Revalidate paths to reflect reaction count updates
    const resolvedProduct = interaction.products as any;
    const resolvedPost = interaction.posts as any;

    if (interaction.product_id && resolvedProduct?.slug) {
      revalidatePath(`/product/${resolvedProduct.slug}`);
    } else if (interaction.post_id && resolvedPost?.slug) {
      revalidatePath(`/article/${resolvedPost.slug}`);
    }
    revalidatePath("/cms/interactions");

    return { success: true, count: newCount, hasReacted: !hasReacted };
  } catch (err: any) {
    console.error("Toggle reaction failed:", err);
    return { error: err.message || "An unexpected error occurred." };
  }
}

/**
 * Updates an interaction's status (approved or denied). Admin/Moderator only.
 */
/**
 * Visitor text goes straight into an HTML mail body below. Without this a review
 * containing markup renders as live HTML inside the moderator's mail client.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Publish a staff answer under a review or a post comment.
 *
 * This is the PUBLIC lane of the Messages inbox, and it is a different shape from a
 * private thread on purpose: the parent is already visible on the site and already
 * belongs to a registered account, so the reply is published content, not a private
 * message. Putting it behind a token link would hide a public answer.
 *
 * A reply is stored as `type: 'comment'` with a NULL rating, carrying the PARENT's
 * target. That is not a shortcut — it is the only shape the existing constraints admit
 * (`check_rating_only_for_review` is an exhaustive OR over 'review' and 'comment'), and
 * it is what keeps the reply out of `update_product_ratings`, which aggregates only
 * `type='review' AND status='approved'`. A reply must never move a product's stars.
 */
export async function replyToInteraction(parentId: string, content: string) {
  const supabase = createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return { error: "Not authenticated" };
  }

  const profile = await getProfileWithRoleServerSide(user.id);
  if (!profile || profile.role !== "ADMIN") {
    return { error: "Unauthorized. Admin permissions required to reply." };
  }

  const body = content.trim().slice(0, 5000);
  if (body.length < 2) {
    return { error: "Write a reply before sending." };
  }

  try {
    const admin = getServiceRoleSupabaseClient();

    const { data: parent, error: parentError } = await admin
      .from("cms_interactions")
      .select("id, product_id, post_id, parent_id, products(slug), posts(slug)")
      .eq("id", parentId)
      .single();

    if (parentError || !parent) {
      return { error: "That review or comment no longer exists." };
    }

    // One level only. The schema enforces this too; failing here gives a better message.
    if (parent.parent_id) {
      return { error: "You can only reply to a top-level review or comment." };
    }

    const { error: insertError } = await admin.from("cms_interactions").insert({
      type: "comment",
      status: "approved",
      content: body,
      rating: null,
      user_id: user.id,
      parent_id: parent.id,
      product_id: parent.product_id,
      post_id: parent.post_id,
    });

    if (insertError) {
      console.error("Error publishing reply:", insertError.message);
      return { error: "Could not publish that reply." };
    }

    const productSlug = (parent.products as { slug?: string } | null)?.slug;
    const postSlug = (parent.posts as { slug?: string } | null)?.slug;
    if (productSlug) revalidatePath(`/product/${productSlug}`);
    if (postSlug) revalidatePath(`/article/${postSlug}`);
    revalidatePath("/cms/messages");
    revalidatePath("/cms/interactions");

    return { success: true };
  } catch (error) {
    console.error("replyToInteraction failed:", error);
    return { error: "Could not publish that reply." };
  }
}

export async function updateInteractionStatus(interactionId: string, status: "approved" | "denied") {
  const supabase = createClient();

  // 1. Authenticate user
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return { error: "Not authenticated" };
  }

  // 2. Authorize as Admin or Writer
  const profile = await getProfileWithRoleServerSide(user.id);
  if (!profile || (profile.role !== "ADMIN" && profile.role !== "WRITER")) {
    return { error: "Unauthorized. Admin or Writer permissions required." };
  }

  // 3. Admin-only rule for denying/approving if strict
  if (profile.role !== "ADMIN") {
    // If writers are not allowed to moderate, block it. The spec says:
    // "Admin-only permission action to switch states between approved or denied."
    // So let's enforce STRICT Admin only for status updates.
    return { error: "Unauthorized. Admin permissions required to moderate." };
  }

  try {
    const admin = getServiceRoleSupabaseClient();
    
    // Fetch interaction details for path revalidation
    const { data: interaction, error: fetchError } = await admin
      .from("cms_interactions")
      .select("product_id, post_id, products(slug), posts(slug)")
      .eq("id", interactionId)
      .single();

    if (fetchError || !interaction) {
      return { error: "Interaction not found." };
    }

    // 4. Update status
    const { error: updateError } = await admin
      .from("cms_interactions")
      .update({ status })
      .eq("id", interactionId);

    if (updateError) {
      console.error("Error updating status:", updateError);
      return { error: `Failed to update status: ${updateError.message}` };
    }

    // 5. Revalidate paths
    const resolvedProduct = interaction.products as any;
    const resolvedPost = interaction.posts as any;

    if (interaction.product_id && resolvedProduct?.slug) {
      revalidatePath(`/product/${resolvedProduct.slug}`);
    } else if (interaction.post_id && resolvedPost?.slug) {
      revalidatePath(`/article/${resolvedPost.slug}`);
    }
    revalidatePath("/cms/interactions");

    return { success: true };
  } catch (err: any) {
    console.error("Update interaction status failed:", err);
    return { error: err.message || "An unexpected error occurred." };
  }
}

/**
 * The service-role client for a signed-in ADMIN whose second factor is satisfied, or the
 * error to return. `interactions_notification_emails` sits above the staff read tier of
 * site_settings and, since migration 02028, behind public.is_admin_mfa() for writes, so the
 * cookie client misses it for an admin on an aal1 session (a "remember this device" login,
 * or the email second factor); a redirected address would receive every moderation notice.
 */
async function requireNotificationSettingsAdmin() {
  try {
    const { supabase } = await requireCmsAdmin();
    return { supabase, error: null };
  } catch (err) {
    const forbidden = err instanceof Error && err.message === "Forbidden";
    return { supabase: null, error: forbidden ? "Unauthorized. Admin role required." : "Not authenticated" };
  }
}

/**
 * Fetches the interactions notification emails from site_settings.
 */
export async function getNotificationEmails() {
  const auth = await requireNotificationSettingsAdmin();
  if (auth.error !== null) return { error: auth.error };
  const { supabase } = auth;

  try {
    const { data, error } = await supabase
      .from("site_settings")
      .select("value")
      .eq("key", "interactions_notification_emails")
      .maybeSingle();

    if (error) throw error;
    
    return { success: true, emails: (data?.value as any)?.emails || "" };
  } catch (err: any) {
    console.error("Failed to fetch notification emails:", err);
    return { error: err.message || "Failed to fetch settings." };
  }
}

/**
 * Saves the interactions notification emails to site_settings.
 */
export async function saveNotificationEmails(emails: string) {
  const auth = await requireNotificationSettingsAdmin();
  if (auth.error !== null) return { error: auth.error };
  const { supabase } = auth;

  // Validate every address, dedupe (case-insensitive), and normalize to lowercase.
  // Mirrors the client-side check so a crafted/legacy payload can't persist junk.
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const tokens = emails
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (!emailRe.test(lower)) {
      invalid.push(token);
      continue;
    }
    if (seen.has(lower)) continue;
    seen.add(lower);
    valid.push(lower);
  }

  if (invalid.length > 0) {
    return {
      error: `Invalid email address${invalid.length > 1 ? "es" : ""}: ${invalid.join(", ")}`,
    };
  }

  const cleaned = valid.join(", ");

  try {
    const { error } = await supabase
      .from("site_settings")
      .upsert({
        key: "interactions_notification_emails",
        value: { emails: cleaned },
      });

    if (error) throw error;

    return { success: true, emails: cleaned };
  } catch (err: any) {
    console.error("Failed to save notification emails:", err);
    return { error: err.message || "Failed to save settings." };
  }
}
