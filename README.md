# Booking System Backend API

Vercel serverless functions backend for the booking system.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env.local` with MongoDB URI:
```
MONGODB_URI=your_mongodb_connection_string
```

3. Run locally:
```bash
npm run dev
```

## API Endpoints

- **Health Check**: `GET /api/health`
- **Get All Bookings**: `GET /api/bookings`
- **Create Booking**: `POST /api/bookings`
- **Get Single Booking**: `GET /api/bookings/[id]`
- **Update Booking Status**: `PATCH /api/bookings/[id]`
- **Delete Booking**: `DELETE /api/bookings/[id]`
- **Get Statistics**: `GET /api/bookings/stats/summary`

## Query Parameters

### Get All Bookings
- `status`: Filter by status (Pending, In Progress, Completed, Cancelled, or 'all')
- `search`: Search by bookingId, customer name, or email
- `limit`: Number of results (default: 50)

## Deployment

Push to GitHub and Vercel will auto-deploy.

Vercel Dashboard > Environment Variables > Add `MONGODB_URI`