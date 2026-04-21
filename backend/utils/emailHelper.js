import nodemailer from 'nodemailer';

const sendInterviewEmail = async (recipientEmail, meetingLink) => {
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: recipientEmail,
            subject: 'Hire-Wire: Technical Assessment Invitation',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #334155; border-radius: 8px; background-color: #0f172a; color: #f8fafc;">
                    <div style="padding: 20px; text-align: center; border-bottom: 1px solid #334155;">
                        <h2 style="margin: 0; color: #3b82f6;">Hire-Wire</h2>
                    </div>
                    <div style="padding: 30px;">
                        <p>Hello,</p>
                        <p>You have been invited to complete a secure technical assessment.</p>
                        <p style="color: #94a3b8; font-size: 14px;"><strong>Note:</strong> Ensure you are in a quiet room with a working webcam and microphone. Tab-switching and background noise will be monitored by the AI proctor.</p>
                        
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${meetingLink}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                                Enter Secure Environment
                            </a>
                        </div>
                        
                        <p style="font-size: 12px; color: #64748b; text-align: center;">Or copy this link: <br>${meetingLink}</p>
                    </div>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error("Email sending failed:", error);
        return false;
    }
};

export { sendInterviewEmail };