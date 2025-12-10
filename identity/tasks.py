from celery import shared_task
from django.conf import settings
from twilio.rest import Client as TwilioClient
from sendgrid import SendGridAPIClient
from sendgrid.helpers.mail import Mail


@shared_task
def send_otp_email(identifier, otp, purpose):
    """
    Send OTP via email using SendGrid.
    
    Args:
        identifier: Email address
        otp: The OTP code to send
        purpose: Purpose of OTP (register, login, verify)
    """
    sendgrid_api_key = getattr(settings, 'SENDGRID_API_KEY', None)
    from_email = getattr(settings, 'SENDGRID_FROM_EMAIL', 'noreply@example.com')
    
    if not sendgrid_api_key:
        raise ValueError("SENDGRID_API_KEY is not configured")
    
    # Determine email subject and content based on purpose
    purpose_messages = {
        'register': {
            'subject': 'Settle - Your Registration OTP',
            'message': 'Use this code to complete your registration: {otp}'
        },
        'login': {
            'subject': 'Settle - Your Login OTP',
            'message': 'Use this code to log in: {otp}'
        },
        'verify': {
            'subject': 'Settle - Your Verification OTP',
            'message': 'Use this code to verify your contact information: {otp}'
        }
    }
    
    message_info = purpose_messages.get(purpose, {
        'subject': 'Settle - Your OTP Code',
        'message': 'Your OTP code is: {otp}'
    })
    
    subject = message_info['subject']
    message = message_info['message'].format(otp=otp)
    
    try:
        sg = SendGridAPIClient(sendgrid_api_key)
        
        mail = Mail(
            from_email=from_email,
            to_emails=identifier,
            subject=subject,
            plain_text_content=message
        )
        
        response = sg.send(mail)
        return {
            'success': True,
            'status_code': response.status_code,
            'identifier': identifier
        }
    except Exception as e:
        # Log error but don't raise to avoid task retry issues
        return {
            'success': False,
            'error': str(e),
            'identifier': identifier
        }


@shared_task
def send_otp_phone(identifier, otp, purpose):
    """
    Send OTP via SMS using Twilio.
    
    Args:
        identifier: Phone number (E.164 format)
        otp: The OTP code to send
        purpose: Purpose of OTP (register, login, verify)
    """
    account_sid = getattr(settings, 'TWILIO_ACCOUNT_SID', None)
    auth_token = getattr(settings, 'TWILIO_AUTH_TOKEN', None)
    from_number = getattr(settings, 'TWILIO_PHONE_NUMBER', None)
    
    if not all([account_sid, auth_token, from_number]):
        raise ValueError("Twilio credentials are not fully configured")
    
    # Determine message based on purpose
    purpose_messages = {
        'register': 'Settle - Your registration code is: {otp}',
        'login': 'Settle - Your login code is: {otp}',
        'verify': 'Settle - Your verification code is: {otp}'
    }
    
    message_template = purpose_messages.get(
        purpose,
        'Your code is: {otp}'
    )
    message_body = message_template.format(otp=otp)
    
    try:
        client = TwilioClient(account_sid, auth_token)
        
        message = client.messages.create(
            body=message_body,
            from_=from_number,
            to=identifier
        )
        
        return {
            'success': True,
            'message_sid': message.sid,
            'status': message.status,
            'identifier': identifier
        }
    except Exception as e:
        # Log error but don't raise to avoid task retry issues
        return {
            'success': False,
            'error': str(e),
            'identifier': identifier
        }
