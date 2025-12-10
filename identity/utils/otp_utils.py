import secrets
import hashlib
from django.conf import settings
from django.contrib.auth.hashers import make_password, check_password
import phonenumbers
from phonenumbers import NumberParseException


def generate_otp(length=None):
    """Generate a cryptographically secure random numeric OTP."""
    if length is None:
        length = getattr(settings, 'OTP_LENGTH', 6)
    
    # Generate random OTP using secrets for cryptographic security
    otp = ''.join(str(secrets.randbelow(10)) for _ in range(length))
    return otp


def hash_otp(otp):
    """Hash OTP using Django's password hashing."""
    return make_password(otp)


def verify_otp(otp, otp_hash):
    """Verify OTP against hash."""
    return check_password(otp, otp_hash)


def normalize_phone(phone_number: str) -> str | None:
    """
    Normalize phone number using phonenumbers library.
    Returns E.164 format (e.g., +1234567890).
    """
    if not phone_number:
        return None
    
    try:
        # Try to parse the phone number
        parsed = phonenumbers.parse(phone_number, None)
        
        # Check if valid
        if not phonenumbers.is_valid_number(parsed):
            return None
        
        # Return in E.164 format
        return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
    except NumberParseException:
        return None


def normalize_email(email: str) -> str | None:
    """Normalize email address (lowercase, strip whitespace)."""
    if not email:
        return None
    
    return email.lower().strip()


def extract_country_from_phone(phone_number: str) -> str | None:
    """
    Extract country code from phone number.
    Returns ISO country code (e.g., 'US', 'GB').
    """
    if not phone_number:
        return None
    
    try:
        parsed = phonenumbers.parse(phone_number, None)
        region = phonenumbers.region_code_for_number(parsed)
        return region
    except (NumberParseException, AttributeError):
        return None


def country_code_to_currency_code(country_code: str) -> str | None:
    """
    Convert ISO country code to ISO currency code.
    Returns 3-character currency code (e.g., 'USD', 'EUR') or None if not found.
    
    Common mappings:
    - US -> USD
    - GB -> GBP
    - CA -> CAD
    - AU -> AUD
    - DE -> EUR
    - FR -> EUR
    - etc.
    """
    if not country_code:
        return None
    
    # Common country to currency mappings
    # Note: This is a simplified mapping. For production, consider using a library
    # like pycountry or a more comprehensive mapping
    country_to_currency = {
        'US': 'USD', 'GB': 'GBP', 'CA': 'CAD', 'AU': 'AUD',
        'DE': 'EUR', 'FR': 'EUR', 'IT': 'EUR', 'ES': 'EUR',
        'NL': 'EUR', 'BE': 'EUR', 'AT': 'EUR', 'PT': 'EUR',
        'IE': 'EUR', 'FI': 'EUR', 'GR': 'EUR', 'LU': 'EUR',
        'JP': 'JPY', 'CN': 'CNY', 'IN': 'INR', 'BR': 'BRL',
        'MX': 'MXN', 'KR': 'KRW', 'SG': 'SGD', 'HK': 'HKD',
        'NZ': 'NZD', 'CH': 'CHF', 'SE': 'SEK', 'NO': 'NOK',
        'DK': 'DKK', 'PL': 'PLN', 'TR': 'TRY', 'ZA': 'ZAR',
        'RU': 'RUB', 'AE': 'AED', 'SA': 'SAR', 'IL': 'ILS',
    }
    
    return country_to_currency.get(country_code.upper())

