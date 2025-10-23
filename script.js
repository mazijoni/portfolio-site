const form = document.getElementById('contactForm');

    form.addEventListener('submit', async (e) => {
    e.preventDefault(); // Prevent default navigation

    const formData = new FormData(form);

    try {
        const response = await fetch('https://jonatan67.app.n8n.cloud/webhook/email-check', {
        method: 'POST',
        body: formData
        });

        if (response.ok) {
        alert('Message sent successfully!');
        form.reset();
        } else {
        alert('Failed to send message.');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('An error occurred.');
    }
    });