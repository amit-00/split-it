from django.db import models
import uuid


class User(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.CharField(max_length=255, null=True, blank=True)
    phone = models.CharField(max_length=20, null=True, blank=True, unique=True)
    name = models.CharField(max_length=255, null=True, blank=True)
    def_curr = models.CharField(max_length=3, null=True, blank=True)  # Currency code (e.g., USD, EUR)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'users'
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name or 'Unknown'} ({self.phone or self.email or 'No contact'})"


class OtpEvent(models.Model):
    CHANNEL_CHOICES = [
        ('email', 'Email'),
        ('phone', 'Phone'),
    ]

    PURPOSE_CHOICES = [
        ('register', 'Register'),
        ('login', 'Login'),
        ('verify', 'Verify'),
    ]

    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('verified', 'Verified'),
        ('expired', 'Expired'),
        ('failed', 'Failed'),
        ('cancelled', 'Cancelled'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='otp_events'
    )
    channel = models.CharField(max_length=10, choices=CHANNEL_CHOICES)
    identifier = models.CharField(max_length=255)  # email or phone number
    purpose = models.CharField(max_length=20, choices=PURPOSE_CHOICES)
    otp_hash = models.CharField(max_length=255)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    attempt_count = models.PositiveIntegerField(default=0)
    requested_ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.TextField()
    metadata = models.JSONField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'otp_events'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['identifier', 'channel', 'status']),
            models.Index(fields=['user', 'status']),
        ]

    def __str__(self):
        return f"OTP {self.id} - {self.channel} - {self.purpose} - {self.status}"
