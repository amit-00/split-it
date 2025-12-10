from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import OtpRequestView, OtpVerifyView, UserViewSet

router = DefaultRouter()
router.register(r'users', UserViewSet, basename='user')

urlpatterns = [
    path('auth/otp/request', OtpRequestView.as_view(), name='otp-request'),
    path('auth/otp/verify', OtpVerifyView.as_view(), name='otp-verify'),
    path('', include(router.urls)),
]

