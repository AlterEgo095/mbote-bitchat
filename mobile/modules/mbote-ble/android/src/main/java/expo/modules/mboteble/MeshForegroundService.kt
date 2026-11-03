package expo.modules.mboteble

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Service au premier plan (type connectedDevice) : maintient le moteur BLE
 * vivant pendant que l'app est en arrière-plan, avec une notification
 * discrète et permanente — obligatoire sur Android 8+.
 */
class MeshForegroundService : Service() {

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Mesh Mbote",
                    NotificationManager.IMPORTANCE_MIN
                ).apply {
                    description = "Relais des messages Mbote via Bluetooth"
                    setShowBadge(false)
                }
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification: Notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Mbote mesh actif")
            .setContentText("Relais des messages hors-ligne via Bluetooth")
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val CHANNEL_ID = "mbote_mesh"
        const val NOTIFICATION_ID = 0x4D42 // 'MB'

        fun start(context: Context) {
            val intent = Intent(context, MeshForegroundService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (_: Throwable) {
            }
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, MeshForegroundService::class.java))
            } catch (_: Throwable) {
            }
        }
    }
}
