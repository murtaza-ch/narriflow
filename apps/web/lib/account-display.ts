export function getDisplayName(firstName: string | null, lastName: string | null) {
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : "Account";
}

export function getInitials(
  firstName: string | null,
  lastName: string | null,
  email: string | null,
) {
  const source = [firstName, lastName].filter(Boolean) as string[];
  if (source.length > 0) {
    return source.map((part) => part.charAt(0).toUpperCase()).join("").slice(0, 2);
  }
  if (email && email.length > 0) {
    return email.charAt(0).toUpperCase();
  }
  return "U";
}
