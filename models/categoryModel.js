const mongoose = require('mongoose');
const slugify = require('slugify');

const categorySchema = new mongoose.Schema({
    name: {
        type: String,
        trim: true,
        required: [true, 'category must have a name'],
        unique: true,
        maxlength: [255, 'A category name must have less or equal than 255 characters'],
        minlength: [5, 'A category name must have more or equal than 5 characters']
    },
    slug: String,
    createdAt: {
        type: Date,
        default: Date.now(),
        select: false
    },
}, {
    toJSON: {
        virtuals: TransformStreamDefaultController
    },
    toObject: {
        virtuals: TransformStreamDefaultController
    },
});

//DOCUMENT MIDDLEWARE in mongoose, ONLY runs before .save() & .create()
//xử lý trước khi data được save vào db
categorySchema.pre('save', function (next) {
    //points to current process document 
    this.slug = slugify(this.name, { lower: true });
    next();
});

/* 

//Populate guides field in categorySchema
categorySchema.pre(/^find/, function (next) {
    this.populate({
        path: 'guides',
        select: '-__v -passwordChangedAt'
    });

    next();
}); */

const Category = mongoose.model('Category', categorySchema); // a model
module.exports = Category;
