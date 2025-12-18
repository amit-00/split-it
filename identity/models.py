from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """
    Custom User model extending AbstractUser.
    Regular users are passwordless (OAuth only).
    Only superusers/admins have passwords.
    """
    pref_curr = models.CharField(
        max_length=3,
        blank=True,
        null=True,
        help_text="Preferred currency in ISO 4217 format (e.g., USD, EUR, GBP)"
    )

    def save(self, *args, **kwargs):
        """
        Override save to set unusable password for regular users.
        Only superusers/admins can have passwords.
        """
        # Call parent save first
        super().save(*args, **kwargs)
        
        # After save, ensure regular users (non-superuser, non-staff) have unusable passwords
        # This handles OAuth-created users who shouldn't have passwords
        if not (self.is_superuser or self.is_staff):
            # If they somehow have a usable password, make it unusable
            if self.has_usable_password():
                self.set_unusable_password()
                # Save again to persist the unusable password
                super().save(update_fields=['password'])

    class Meta:
        db_table = 'users'
        verbose_name = 'user'
        verbose_name_plural = 'users'
