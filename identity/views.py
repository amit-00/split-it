from typing import Type, Union
from datetime import datetime
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from django.utils import timezone
from django.conf import settings
from django.db import transaction
from rest_framework_simplejwt.tokens import RefreshToken
import uuid

from .models import User, OtpEvent
from .serializers import (
    OtpRequestSerializer,
    OtpVerifySerializer,
    UserSerializer,
    UserCreateSerializer,
    UserUpdateSerializer
)
from .utils.otp_utils import (
    generate_otp,
    hash_otp,
    verify_otp,
    normalize_phone,
    normalize_email,
    extract_country_from_phone,
    country_code_to_currency_code
)
from .utils.redis_utils import (
    store_otp_state,
    get_otp_state,
    delete_otp_state,
    check_cooldown,
    set_cooldown,
    check_identifier_rate_limit,
    increment_rate_limit
)
from .tasks import send_otp_email, send_otp_phone


def get_client_ip(request: Request) -> str | None:
    """Extract client IP address from request."""
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        ip = x_forwarded_for.split(',')[0]
    else:
        ip = request.META.get('REMOTE_ADDR')
    return ip


def get_user_agent(request: Request) -> str:
    """Extract user agent from request."""
    return request.META.get('HTTP_USER_AGENT', '')


class OtpRequestView(APIView):
    """Handle OTP request endpoint."""
    permission_classes = [AllowAny]

    def post(self, request: Request) -> Response:
        serializer = OtpRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        channel = serializer.validated_data['channel']
        identifier = serializer.validated_data['identifier']
        purpose = serializer.validated_data['purpose']
        user_id = serializer.validated_data.get('user_id')

        # Validate: registration only through phone
        if purpose == 'register' and channel != 'phone':
            return Response(
                {'error': 'Registration is only allowed through phone'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Normalize identifier
        if channel == 'phone':
            normalized_identifier = normalize_phone(identifier)
            if not normalized_identifier:
                return Response(
                    {'error': 'Invalid phone number format'},
                    status=status.HTTP_400_BAD_REQUEST
                )
        else:  # email
            normalized_identifier = normalize_email(identifier)
            if not normalized_identifier:
                return Response(
                    {'error': 'Invalid email format'},
                    status=status.HTTP_400_BAD_REQUEST
                )

        # Extract IP and user agent
        ip_address = get_client_ip(request)
        user_agent = get_user_agent(request)

        # Rate limiting checks
        # Check cooldown
        in_cooldown, cooldown_remaining = check_cooldown(normalized_identifier, channel)
        if in_cooldown:
            return Response(
                {
                    'error': 'Too soon to request new token',
                    'cooldown_remaining': cooldown_remaining
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS
            )

        # Check identifier rate limit
        is_over_limit, remaining, reset_seconds = check_identifier_rate_limit(normalized_identifier, channel)
        if is_over_limit:
            return Response(
                {
                    'error': 'Must wait to issue new tokens',
                    'reset_seconds': reset_seconds
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS
            )

        # Validate purpose-specific requirements
        user = None
        if purpose == 'verify':
            if not user_id:
                return Response(
                    {'error': 'user_id is required for verify purpose'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            try:
                user = User.objects.get(id=user_id)
            except User.DoesNotExist:
                return Response(
                    {'error': 'User not found'},
                    status=status.HTTP_404_NOT_FOUND
                )
        elif purpose == 'login':
            # Query for user with identifier
            if channel == 'phone':
                try:
                    user = User.objects.get(phone=normalized_identifier)
                except User.DoesNotExist:
                    pass  # User doesn't exist yet, which is fine for login attempt
            else:  # email
                try:
                    user = User.objects.get(email=normalized_identifier)
                except User.DoesNotExist:
                    pass

        # Generate OTP
        otp = generate_otp()
        otp_hash = hash_otp(otp)

        # Calculate expiration
        expires_at = timezone.now() + timezone.timedelta(
            minutes=getattr(settings, 'OTP_EXPIRY_MINUTES', 10)
        )

        # Create OtpEvent record
        otp_event = OtpEvent.objects.create(
            user=user,
            channel=channel,
            identifier=normalized_identifier,
            purpose=purpose,
            otp_hash=otp_hash,
            expires_at=expires_at,
            status='pending',
            attempt_count=0,
            requested_ip=ip_address,
            user_agent=user_agent
        )

        # Store in Redis
        otp_data = {
            'otp_hash': otp_hash,
            'event_id': str(otp_event.id),
            'expires_at': expires_at.isoformat(),
            'max_attempts': getattr(settings, 'OTP_MAX_ATTEMPTS', 5),
            'attempts': 0
        }
        store_otp_state(normalized_identifier, channel, otp_data)

        # Set cooldown
        set_cooldown(normalized_identifier, channel)

        # Increment rate limits
        increment_rate_limit(normalized_identifier, channel)

        # Dispatch Celery task
        if channel == 'phone':
            send_otp_phone.delay(normalized_identifier, otp, purpose)
        else:  # email
            send_otp_email.delay(normalized_identifier, otp, purpose)


        return Response(
            {'message': 'OTP sent successfully'},
            status=status.HTTP_202_ACCEPTED
        )


class OtpVerifyView(APIView):
    """Handle OTP verification endpoint."""
    permission_classes = [AllowAny]

    def post(self, request: Request) -> Response:
        serializer = OtpVerifySerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

        channel = serializer.validated_data['channel']
        identifier = serializer.validated_data['identifier']
        purpose = serializer.validated_data['purpose']
        user_id = serializer.validated_data.get('user_id')
        otp = serializer.validated_data['otp']  # Already a string, no conversion needed

        # Normalize identifier
        if channel == 'phone':
            normalized_identifier = normalize_phone(identifier)
            if not normalized_identifier:
                return Response(
                    {'error': 'Invalid phone number format'},
                    status=status.HTTP_400_BAD_REQUEST
                )
        else:  # email
            normalized_identifier = normalize_email(identifier)
            if not normalized_identifier:
                return Response(
                    {'error': 'Invalid email format'},
                    status=status.HTTP_400_BAD_REQUEST
                )

        # Load OTP from Redis
        otp_state = get_otp_state(normalized_identifier, channel)
        if not otp_state:
            return Response(
                {'error': 'OTP not found or expired'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Get OtpEvent from database
        try:
            otp_event = OtpEvent.objects.get(id=otp_state['event_id'])
        except OtpEvent.DoesNotExist:
            return Response(
                {'error': 'OTP event not found'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Check expiration (defensive check)
        expires_at = otp_event.expires_at
        if timezone.now() > expires_at:
            otp_event.status = 'expired'
            otp_event.save()
            delete_otp_state(normalized_identifier, channel)
            return Response(
                {'error': 'OTP expired'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Check attempts
        max_attempts = otp_state.get('max_attempts', getattr(settings, 'OTP_MAX_ATTEMPTS', 5))
        if otp_state['attempts'] >= max_attempts:
            otp_event.status = 'failed'
            otp_event.attempt_count = otp_state['attempts']
            otp_event.save()
            delete_otp_state(normalized_identifier, channel)
            return Response(
                {'error': 'Too many failed attempts'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Increment attempts
        otp_state['attempts'] += 1
        otp_event.attempt_count = otp_state['attempts']
        otp_event.save()

        # Verify OTP
        if not verify_otp(otp, otp_state['otp_hash']):
            # Write back to Redis with same TTL using the same logic as store_otp_state
            otp_state['expires_at'] = expires_at.isoformat()
            store_otp_state(normalized_identifier, channel, otp_state)
            
            return Response(
                {'error': 'Incorrect OTP'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # OTP verified successfully
        # Mark as verified and consumed
        otp_event.status = 'verified'
        otp_event.consumed_at = timezone.now()
        otp_event.attempt_count = otp_state['attempts']
        otp_event.save()

        # Delete from Redis
        delete_otp_state(normalized_identifier, channel)

        # Handle purpose-specific logic
        response_data = {}

        if purpose == 'register':
            # Create user account
            with transaction.atomic():
                user = User.objects.create(
                    phone=normalized_identifier if channel == 'phone' else None,
                    email=normalized_identifier if channel == 'email' else None
                )
                # Generate JWT tokens
                refresh = RefreshToken()
                refresh['user_id'] = str(user.id)
                access_token = refresh.access_token
                response_data = {
                    'user': UserSerializer(user).data,
                    'access': str(access_token),
                    'refresh': str(refresh)
                }

        elif purpose == 'login':
            # Find or create user
            if channel == 'phone':
                user, created = User.objects.get_or_create(
                    phone=normalized_identifier,
                    defaults={'email': None}
                )
            else:  # email
                user, created = User.objects.get_or_create(
                    email=normalized_identifier,
                    defaults={'phone': None}
                )
            
            # Generate JWT tokens
            refresh = RefreshToken()
            refresh['user_id'] = str(user.id)
            access_token = refresh.access_token
            response_data = {
                'user': UserSerializer(user).data,
                'access': str(access_token),
                'refresh': str(refresh)
            }

        elif purpose == 'verify':
            # Update user account
            if not user_id:
                return Response(
                    {'error': 'user_id is required for verify purpose'},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            try:
                user = User.objects.get(id=user_id)
                if channel == 'phone':
                    user.phone = normalized_identifier
                else:  # email
                    user.email = normalized_identifier
                user.save()
                response_data = {
                    'user': UserSerializer(user).data,
                    'message': 'Contact information updated successfully'
                }
            except User.DoesNotExist:
                return Response(
                    {'error': 'User not found'},
                    status=status.HTTP_404_NOT_FOUND
                )

        return Response(response_data, status=status.HTTP_200_OK)


class UserViewSet(viewsets.ModelViewSet):
    """ViewSet for User CRUD operations."""
    queryset = User.objects.all()
    serializer_class = UserSerializer
    lookup_field = 'id'

    def get_serializer_class(self) -> Type[Union[UserSerializer, UserCreateSerializer, UserUpdateSerializer]]:
        if self.action == 'create':
            return UserCreateSerializer
        elif self.action in ['partial_update', 'update']:
            return UserUpdateSerializer
        return UserSerializer
    
    def list(self, request: Request) -> Response:
        """GET /users - Not supported. Use /users?phone=... to lookup by phone instead."""
        phone = request.query_params.get('phone')
        if not phone:
            return Response(
                {'error': 'Can only query with phone number'},
                status=status.HTTP_400_BAD_REQUEST
            )
        normalized_phone = normalize_phone(phone)
        if not normalized_phone:
            return Response(
                {'error': 'Invalid phone number format'},
                status=status.HTTP_400_BAD_REQUEST
            )
        try:
            user = User.objects.get(phone=normalized_phone)
            return Response(UserSerializer(user).data, status=status.HTTP_200_OK)
        except User.DoesNotExist:
            return Response(
                {'error': 'User not found'},
                status=status.HTTP_404_NOT_FOUND
            )

    def create(self, request: Request) -> Response:
        """POST /users - Create user with phone."""
        serializer = UserCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        
        phone = serializer.validated_data['phone']
        
        # Normalize phone
        normalized_phone = normalize_phone(phone)
        if not normalized_phone:
            return Response(
                {'error': 'Invalid phone number format'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Extract country from phone and convert to currency code
        country_code = extract_country_from_phone(normalized_phone)
        if not country_code:
            return Response(
                {'error': 'Invalid phone number format'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Convert country code to currency code
        currency_code = country_code_to_currency_code(country_code)
        
        # Create user with currency code (or None if conversion failed)
        user = User.objects.create(phone=normalized_phone, def_curr=currency_code)
        
        return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)

    def partial_update(self, request: Request, id: uuid.UUID | str | None = None) -> Response:
        """PATCH /users/<id> - Update user name and/or def_curr."""
        try:
            user = User.objects.get(id=id)
        except User.DoesNotExist:
            return Response(
                {'error': 'User not found'},
                status=status.HTTP_404_NOT_FOUND
            )
        
        serializer = UserUpdateSerializer(data=request.data, partial=True)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        
        # Update fields
        if 'name' in serializer.validated_data:
            user.name = serializer.validated_data['name']
        if 'def_curr' in serializer.validated_data:
            user.def_curr = serializer.validated_data['def_curr']
        
        user.save()
        
        return Response(UserSerializer(user).data, status=status.HTTP_200_OK)
    
