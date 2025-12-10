import json
import uuid
from datetime import datetime
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone


def _get_otp_key(channel: str, identifier: str) -> str:
    """Generate Redis key for OTP state."""
    return f"otp:{channel}:{identifier}"


def _calculate_ttl_from_expires_at(expires_at: datetime | str) -> int | None:
    """
    Calculate TTL in seconds from expires_at datetime.
    
    Args:
        expires_at: datetime object, ISO8601 string, or None
        
    Returns:
        TTL in seconds, or None if expires_at is invalid or already expired
    """
    # Parse string to datetime if needed
    if isinstance(expires_at, str):
        try:
            # Handle ISO8601 format with or without timezone
            if expires_at.endswith('Z'):
                expires_at = expires_at.replace('Z', '+00:00')
            expires_at = datetime.fromisoformat(expires_at)
        except (ValueError, AttributeError):
            return None
    
    # Django's timezone.now() always returns timezone-aware datetime
    now = timezone.now()
    
    # Convert expires_at to timezone-aware if it's naive
    if not timezone.is_aware(expires_at):
        expires_at = timezone.make_aware(expires_at)
    
    # Calculate TTL
    ttl = int((expires_at - now).total_seconds())
    
    # Return None if already expired (instead of negative TTL)
    return ttl if ttl > 0 else None


def _get_cooldown_key(channel: str, identifier: str) -> str:
    """Generate Redis key for cooldown."""
    return f"cooldown:{channel}:{identifier}"


def _get_identifier_rate_limit_key(channel: str, identifier: str) -> str:
    """Generate Redis key for identifier rate limit."""
    return f"ratelimit:identifier:{channel}:{identifier}"


def store_otp_state(identifier: str, channel: str, otp_data: dict) -> bool:
    """
    Store OTP state in Redis with TTL.
    
    Uses production-ready timezone-aware datetime handling.
    Works correctly regardless of deployment timezone or user location.
    
    Args:
        identifier: Normalized email or phone
        channel: 'email' or 'phone'
        otp_data: Dict with otp_hash, event_id, expires_at, max_attempts, attempts
                 expires_at can be datetime, ISO8601 string, or None
    """
    key = _get_otp_key(channel, identifier)
    
    # Calculate TTL from expires_at using consistent timezone handling
    expires_at = otp_data.get('expires_at')
    ttl = _calculate_ttl_from_expires_at(expires_at)
    
    # If TTL calculation failed or expired, use fallback
    if ttl is None:
        # Fallback: use OTP_EXPIRY_MINUTES
        ttl = getattr(settings, 'OTP_EXPIRY_MINUTES', 10) * 60
    
    # Store as JSON string
    cache.set(key, json.dumps(otp_data), timeout=ttl)
    return True


def get_otp_state(identifier, channel):
    """
    Retrieve OTP state from Redis.
    
    Returns:
        Dict with otp_hash, event_id, expires_at, max_attempts, attempts, or None
    """
    key = _get_otp_key(channel, identifier)
    data = cache.get(key)
    
    if data is None:
        return None
    
    try:
        return json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return None


def delete_otp_state(identifier, channel):
    """Remove OTP from Redis."""
    key = _get_otp_key(channel, identifier)
    cache.delete(key)


def check_cooldown(identifier, channel):
    """
    Check if identifier is within cooldown period.
    
    Returns:
        Tuple (is_in_cooldown, seconds_remaining)
    """
    key = _get_cooldown_key(channel, identifier)
    ttl = cache.ttl(key)
    
    if ttl is None or ttl <= 0:
        return False, 0
    
    return True, ttl


def set_cooldown(identifier, channel, duration=None):
    """
    Set cooldown period for identifier.
    
    Args:
        identifier: Normalized email or phone
        channel: 'email' or 'phone'
        duration: Cooldown duration in seconds (defaults to OTP_COOLDOWN_SECONDS)
    """
    if duration is None:
        duration = getattr(settings, 'OTP_COOLDOWN_SECONDS', 60)
    
    key = _get_cooldown_key(channel, identifier)
    cache.set(key, '1', timeout=duration)


def check_identifier_rate_limit(identifier, channel):
    """
    Check per-identifier rate limit.
    
    Returns:
        Tuple (is_over_limit, requests_remaining, reset_seconds)
    """
    key = _get_identifier_rate_limit_key(channel, identifier)
    count = cache.get(key, 0)
    
    limit = getattr(settings, 'RATE_LIMIT_IDENTIFIER_PER_HOUR', 5)
    ttl = cache.ttl(key)
    
    if ttl is None or ttl <= 0:
        # No existing limit, reset to 1 hour
        ttl = 3600
    
    is_over_limit = count >= limit
    requests_remaining = max(0, limit - count)
    
    return is_over_limit, requests_remaining, ttl


def increment_rate_limit(identifier: str, channel: str):
    """
    Increment rate limit counter for identifier.
    Sets TTL to 1 hour if key doesn't exist.
    
    Args:
        identifier: Normalized identifier (email/phone)
        channel: Channel (email/phone)
    """
    # Increment identifier rate limit
    identifier_key = _get_identifier_rate_limit_key(channel, identifier)
    identifier_count = cache.get(identifier_key, 0)
    cache.set(identifier_key, identifier_count + 1, timeout=3600)
