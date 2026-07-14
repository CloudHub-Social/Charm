import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { avatarColor, initials } from "./roomDisplay";

export interface MessagePillProfile {
  userId: string;
  label: string;
}

export function MessagePillProfileDialog({
  profile,
  onClose,
}: {
  profile: MessagePillProfile | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={profile !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        {profile && (
          <DialogHeader className="items-center text-center">
            <Avatar size="lg">
              <AvatarFallback
                style={{ background: avatarColor(profile.userId) }}
                className="font-bold text-white"
              >
                {initials(profile.userId, profile.label)}
              </AvatarFallback>
            </Avatar>
            <DialogTitle>{profile.label}</DialogTitle>
            <DialogDescription>{profile.userId}</DialogDescription>
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  );
}
